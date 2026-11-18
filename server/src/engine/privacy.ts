import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type {
  Memory,
  MemoryPlaceholder,
  PrivacyAction,
  PrivacyMaskMode,
  PrivacyRule,
  PrivacyRuleInput,
  PrivacyRuleKind,
  PrivacyRuleScope,
  PrivacyScanHit,
  PrivacyScanResult,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { tx } from '../db/index.ts';
import { decryptField, encryptField, encryptionKeyFromEnv } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { memoryContentHash } from '../lib/text.ts';
import { engineErrors } from './errors.ts';
import { writeHistory } from './history.ts';
import { llmText } from './llm.ts';
import { embedText, EMBEDDING_DIM, EMBEDDING_MODEL, embeddingToBlob } from './embed.ts';
import { findPartitionById } from './partition.ts';
import { parseSettings, type MemoryRow } from './rows.ts';

/**
 * v6.2 隐私规则域（schema v8）。
 *
 * - 规则：global + partition 合并（同 code 分区覆盖全局），按 priority 升序执行；
 * - 正则：确定性扫描/替换，支持 mask（email/keepFirstLast/keepLast/full）与 placeholder；
 * - 提示词：交给 LLM 抽取 JSON entities，服务端校验 value 确实出现在原文（防幻觉），失败回退正则；
 * - 占位符：正文只存 `{{key}}`，值加密落 memory_placeholders；读取时按 reveal 解密；
 * - 写/更新/做梦/重扫共用 `applyPrivacyToMemory`（幂等：重复扫描不会二次替换已打码/已占位片段）。
 */

export interface PrivacyRuleRow {
  id: string;
  scope: string;
  partition_id: string;
  code: string;
  name: string;
  kind: string;
  pattern: string | null;
  flags: string;
  instruction: string | null;
  entity_type: string;
  action: string;
  mask_mode: string;
  mask_keep_last: number;
  mask_keep_first: number;
  enabled: number;
  priority: number;
  builtin: number;
  created_at: string;
  updated_at: string;
}

export interface PlaceholderRow {
  id: string;
  partition_id: string;
  memory_id: string;
  placeholder: string;
  value_cipher: string;
  encrypted: number;
  kind: string | null;
  created_at: string;
}

export const PRIVACY_CODE_RE = /^[a-z0-9_]{2,40}$/;
export const PLACEHOLDER_KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;
export const PLACEHOLDER_TOKEN_RE = /\{\{([A-Za-z0-9_-]{3,64})\}\}/g;
const ANY_BRACES_RE = /\{\{([^{}]*)\}\}/g;
const ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'y']);
const ACTIONS: PrivacyAction[] = ['mask', 'placeholder'];
const MASK_MODES: PrivacyMaskMode[] = ['email', 'keepFirstLast', 'keepLast', 'full'];
const MAX_HITS = 2_000;
const MAX_PLACEHOLDER_VALUE_CHARS = 4_000;
const MAX_PLACEHOLDER_MAPPING_KEYS = 200;

/* ------------------------------------------------------------------ */
/* 规则 CRUD                                                           */
/* ------------------------------------------------------------------ */

export function toPrivacyRule(row: PrivacyRuleRow): PrivacyRule {
  return {
    id: row.id,
    scope: row.scope === 'global' ? 'global' : 'partition',
    ...(row.scope === 'global' ? {} : { partitionId: row.partition_id }),
    code: row.code,
    name: row.name,
    kind: row.kind === 'prompt' ? 'prompt' : 'regex',
    ...(row.pattern !== null && row.pattern !== '' ? { pattern: row.pattern } : {}),
    flags: row.flags || 'g',
    ...(row.instruction !== null && row.instruction !== '' ? { instruction: row.instruction } : {}),
    entityType: row.entity_type,
    action: row.action === 'placeholder' ? 'placeholder' : 'mask',
    maskMode: (MASK_MODES as string[]).includes(row.mask_mode) ? (row.mask_mode as PrivacyMaskMode) : 'keepLast',
    maskKeepLast: row.mask_keep_last,
    maskKeepFirst: row.mask_keep_first,
    enabled: row.enabled === 1,
    priority: row.priority,
    builtin: row.builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findPrivacyRule(db: DatabaseSync, id: string): PrivacyRule | null {
  const row = db.prepare('SELECT * FROM privacy_rules WHERE id = ?').get(id) as unknown as PrivacyRuleRow | undefined;
  return row ? toPrivacyRule(row) : null;
}

/** global + partition 合并（同 code 分区覆盖全局），按 priority 升序。不传 partitionId 时只返回全局。 */
export function listPrivacyRules(db: DatabaseSync, partitionId?: string): PrivacyRule[] {
  const globals = db
    .prepare("SELECT * FROM privacy_rules WHERE scope = 'global' ORDER BY priority ASC, code ASC")
    .all() as unknown as PrivacyRuleRow[];
  const merged = new Map<string, PrivacyRuleRow>();
  for (const row of globals) merged.set(row.code, row);
  if (partitionId) {
    const locals = db
      .prepare('SELECT * FROM privacy_rules WHERE scope = \'partition\' AND partition_id = ? ORDER BY priority ASC, code ASC')
      .all(partitionId) as unknown as PrivacyRuleRow[];
    for (const row of locals) merged.set(row.code, row);
  }
  return [...merged.values()]
    .map(toPrivacyRule)
    .sort((left, right) => left.priority - right.priority || left.code.localeCompare(right.code));
}

function normalizeKind(value: unknown): PrivacyRuleKind {
  if (value === 'prompt' || value === 'regex') return value;
  throw engineErrors.validation("kind 必须是 'regex' 或 'prompt'");
}

function normalizeAction(value: unknown, fallback: PrivacyAction = 'mask'): PrivacyAction {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'mask' || value === 'placeholder') return value;
  throw engineErrors.validation("action 必须是 'mask' 或 'placeholder'");
}

function normalizeMaskMode(value: unknown, fallback: PrivacyMaskMode = 'keepLast'): PrivacyMaskMode {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (MASK_MODES as string[]).includes(value)) return value as PrivacyMaskMode;
  throw engineErrors.validation(`maskMode 必须是 ${MASK_MODES.join('/')} 之一`);
}

function normalizeFlags(raw: unknown, fallback = 'g'): string {
  const value = typeof raw === 'string' ? raw.trim() : fallback;
  if (value.length > 8) throw engineErrors.validation('flags 最长 8 个字符');
  const seen = new Set<string>();
  for (const char of value) {
    if (!ALLOWED_FLAGS.has(char)) throw engineErrors.validation(`不支持的 flags：${char}`);
    seen.add(char);
  }
  // 扫描依赖 global 语义；强制包含 g。
  seen.add('g');
  return [...seen].join('');
}

function compileRuleRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw engineErrors.validation(
      `正则无法编译：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

interface NormalizedRuleFields {
  code: string;
  name: string;
  kind: PrivacyRuleKind;
  pattern: string | null;
  flags: string;
  instruction: string | null;
  entityType: string;
  action: PrivacyAction;
  maskMode: PrivacyMaskMode;
  maskKeepLast: number;
  maskKeepFirst: number;
  enabled: number;
  priority: number;
}

function normalizeRuleFields(input: PrivacyRuleInput, existing: PrivacyRuleRow | null): NormalizedRuleFields {
  const codeRaw = (input.code ?? existing?.code ?? '').trim();
  if (!CODE_REValid(codeRaw)) throw engineErrors.validation('code 仅支持小写字母、数字与下划线，长度 2–40');
  const name = (input.name ?? existing?.name ?? '').trim();
  if (!name) throw engineErrors.validation('name 不能为空');
  if (name.length > 80) throw engineErrors.validation('name 最长 80 字符');
  const kind = normalizeKind(input.kind ?? existing?.kind);
  const flags = normalizeFlags(input.flags ?? existing?.flags ?? 'g');
  let pattern: string | null = null;
  let instruction: string | null = null;
  if (kind === 'regex') {
    const rawPattern = input.pattern !== undefined ? String(input.pattern).trim() : (existing?.pattern ?? '').trim();
    if (!rawPattern) throw engineErrors.validation('regex 规则必须提供 pattern');
    if (rawPattern.length > 2_000) throw engineErrors.validation('pattern 最长 2000 字符');
    compileRuleRegex(rawPattern, flags);
    pattern = rawPattern;
    const rawInstruction = input.instruction !== undefined ? String(input.instruction).trim() : (existing?.instruction ?? '').trim();
    instruction = rawInstruction ? rawInstruction.slice(0, 2_000) : null;
  } else {
    const rawInstruction =
      input.instruction !== undefined ? String(input.instruction).trim() : (existing?.instruction ?? '').trim();
    if (!rawInstruction) throw engineErrors.validation('prompt 规则必须提供 instruction');
    instruction = rawInstruction.slice(0, 2_000);
    pattern = null;
  }
  const entityType = (input.entityType ?? existing?.entity_type ?? codeRaw).trim().slice(0, 60) || codeRaw;
  const action = normalizeAction(input.action, existing ? normalizeAction(existing.action) : 'mask');
  const maskMode = normalizeMaskMode(
    input.maskMode,
    existing ? normalizeMaskMode(existing.mask_mode) : 'keepLast',
  );
  const maskKeepLast = clampInt(input.maskKeepLast, existing?.mask_keep_last ?? 4, 0, 64);
  const maskKeepFirst = clampInt(input.maskKeepFirst, existing?.mask_keep_first ?? 0, 0, 64);
  const enabled =
    input.enabled === undefined ? (existing ? existing.enabled : 1) : input.enabled === true ? 1 : 0;
  const priority = clampInt(input.priority, existing?.priority ?? 100, 0, 1_000_000);
  return {
    code: codeRaw,
    name,
    kind,
    pattern,
    flags,
    instruction,
    entityType,
    action,
    maskMode,
    maskKeepLast,
    maskKeepFirst,
    enabled,
    priority,
  };
}

function CODE_REValid(code: string): boolean {
  return PRIVACY_CODE_RE.test(code);
}

function insertRuleRow(
  db: DatabaseSync,
  scope: PrivacyRuleScope,
  partitionId: string,
  fields: NormalizedRuleFields,
  builtin: boolean,
): PrivacyRule {
  const id = newId('prv');
  const at = nowIso();
  try {
    db.prepare(
      `INSERT INTO privacy_rules
         (id, scope, partition_id, code, name, kind, pattern, flags, instruction, entity_type, action,
          mask_mode, mask_keep_last, mask_keep_first, enabled, priority, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      scope,
      scope === 'global' ? '' : partitionId,
      fields.code,
      fields.name,
      fields.kind,
      fields.pattern,
      fields.flags,
      fields.instruction,
      fields.entityType,
      fields.action,
      fields.maskMode,
      fields.maskKeepLast,
      fields.maskKeepFirst,
      fields.enabled,
      fields.priority,
      builtin ? 1 : 0,
      at,
      at,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE')) throw engineErrors.conflict(`同作用域已存在 code=${fields.code} 的隐私规则`);
    throw error;
  }
  const created = findPrivacyRule(db, id);
  if (!created) throw new Error('隐私规则写入失败');
  return created;
}

export function createPrivacyRule(
  db: DatabaseSync,
  scope: PrivacyRuleScope,
  partitionId: string | null,
  input: PrivacyRuleInput,
): PrivacyRule {
  if (scope !== 'global' && scope !== 'partition') throw engineErrors.validation("scope 必须是 'global' 或 'partition'");
  if (scope === 'partition' && !partitionId) throw engineErrors.validation('分区规则必须提供 partition_id');
  if (scope === 'partition' && !findPartitionById(db, partitionId as string)) {
    throw engineErrors.notFound('分区不存在');
  }
  const fields = normalizeRuleFields(input, null);
  return insertRuleRow(db, scope, partitionId ?? '', fields, false);
}

export function updatePrivacyRule(db: DatabaseSync, id: string, input: Partial<PrivacyRuleInput>): PrivacyRule {
  const row = db.prepare('SELECT * FROM privacy_rules WHERE id = ?').get(id) as unknown as PrivacyRuleRow | undefined;
  if (!row) throw engineErrors.notFound('隐私规则不存在');
  const fields = normalizeRuleFields(input as PrivacyRuleInput, row);
  try {
    db.prepare(
      `UPDATE privacy_rules
          SET code = ?, name = ?, kind = ?, pattern = ?, flags = ?, instruction = ?, entity_type = ?,
              action = ?, mask_mode = ?, mask_keep_last = ?, mask_keep_first = ?, enabled = ?, priority = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      fields.code,
      fields.name,
      fields.kind,
      fields.pattern,
      fields.flags,
      fields.instruction,
      fields.entityType,
      fields.action,
      fields.maskMode,
      fields.maskKeepLast,
      fields.maskKeepFirst,
      fields.enabled,
      fields.priority,
      nowIso(),
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE')) throw engineErrors.conflict(`同作用域已存在 code=${fields.code} 的隐私规则`);
    throw error;
  }
  const updated = findPrivacyRule(db, id);
  if (!updated) throw new Error('隐私规则写入失败');
  return updated;
}

export function deletePrivacyRule(db: DatabaseSync, id: string): PrivacyRule {
  const row = db.prepare('SELECT * FROM privacy_rules WHERE id = ?').get(id) as unknown as PrivacyRuleRow | undefined;
  if (!row) throw engineErrors.notFound('隐私规则不存在');
  if (row.builtin === 1) throw engineErrors.validation('内置规则不可删除，可将其 enabled 设为 false');
  db.prepare('DELETE FROM privacy_rules WHERE id = ?').run(id);
  return toPrivacyRule(row);
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

export interface PrivacyScanOptions {
  /** 预取规则（避免预览/批处理重复查询）；缺省从 DB 读取。 */
  rules?: PrivacyRule[];
  llm?: LlmConfig | null;
  /** 是否执行 prompt 规则（还需要 privacyLlmEnabled + llm 均可用）。 */
  allowPrompt?: boolean;
}

function maskKeepLast(value: string, keep: number): string {
  const chars = [...value];
  const count = Math.max(0, Math.min(chars.length, keep));
  if (count === 0) return '*'.repeat(chars.length);
  return '*'.repeat(chars.length - count) + chars.slice(chars.length - count).join('');
}

/** 按规则 maskMode 打码（长度尽量保留，便于审计比对）。 */
export function maskPrivacyValue(value: string, rule: Pick<PrivacyRule, 'maskMode' | 'maskKeepFirst' | 'maskKeepLast'>): string {
  if (!value) return value;
  const chars = [...value];
  const length = chars.length;
  if (rule.maskMode === 'full') return '*'.repeat(length);
  if (rule.maskMode === 'keepLast') return maskKeepLast(value, rule.maskKeepLast);
  if (rule.maskMode === 'keepFirstLast') {
    const first = Math.max(0, Math.min(length, rule.maskKeepFirst));
    let last = Math.max(0, Math.min(length, rule.maskKeepLast));
    // 至少遮住一个字符：短值（如两字姓名 1/1）压缩尾部保留长度，避免整段原样暴露。
    if (first + last >= length) {
      last = Math.max(0, length - first - 1);
      if (first + last >= length) last = Math.max(0, length - Math.max(1, first) - 1);
    }
    return chars.slice(0, first).join('') + '*'.repeat(length - first - last) + chars.slice(length - last).join('');
  }
  // email：local 首字符 + *** + @domain
  const at = value.lastIndexOf('@');
  if (at <= 0) return maskKeepLast(value, rule.maskKeepLast || 4);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

interface Claim {
  start: number;
  end: number;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

interface ScanAccumulator {
  source: string;
  claims: Claim[];
  replacements: Replacement[];
  hits: PrivacyScanHit[];
  placeholders: Record<string, string>;
  valueTokens: Map<string, string>;
  placeholderKinds: Record<string, string>;
}

function overlaps(claims: Claim[], start: number, end: number): boolean {
  for (const claim of claims) {
    if (start < claim.end && end > claim.start) return true;
  }
  return false;
}

export function placeholderTokensOf(text: string): string[] {
  const tokens: string[] = [];
  const re = new RegExp(PLACEHOLDER_TOKEN_RE.source, 'g');
  for (const match of text.matchAll(re)) {
    const key = match[1];
    if (key && !tokens.includes(key)) tokens.push(key);
  }
  return tokens;
}

export function countPlaceholderTokens(text: string): number {
  return placeholderTokensOf(text).length;
}

function newScanAccumulator(text: string): ScanAccumulator {
  const accumulator: ScanAccumulator = {
    source: text,
    claims: [],
    replacements: [],
    hits: [],
    placeholders: {},
    valueTokens: new Map(),
    placeholderKinds: {},
  };
  // 正文中已有的 {{token}} 视为受保护片段：后续规则不会再次扫描 token 内部。
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_TOKEN_RE.source, 'g'))) {
    const start = match.index ?? 0;
    accumulator.claims.push({ start, end: start + match[0].length });
  }
  return accumulator;
}

function tokenForValue(accumulator: ScanAccumulator, value: string): string {
  const existing = accumulator.valueTokens.get(value);
  if (existing) return existing;
  let token = '';
  for (let attempt = 0; attempt < 32; attempt += 1) {
    token = `pii_${randomBytes(4).toString('hex')}`;
    if (!accumulator.placeholders[token] && !accumulator.source.includes(`{{${token}}}`)) break;
  }
  accumulator.valueTokens.set(value, token);
  accumulator.placeholders[token] = value;
  return token;
}

function recordHit(
  accumulator: ScanAccumulator,
  rule: PrivacyRule,
  value: string,
  start: number,
  end: number,
): void {
  if (value.length === 0 || overlaps(accumulator.claims, start, end)) return;
  let replacement: string;
  if (rule.action === 'placeholder') {
    const token = tokenForValue(accumulator, value);
    accumulator.placeholderKinds[token] = rule.entityType;
    replacement = `{{${token}}}`;
  } else {
    replacement = maskPrivacyValue(value, rule);
  }
  accumulator.claims.push({ start, end });
  accumulator.replacements.push({ start, end, text: replacement });
  if (accumulator.hits.length < MAX_HITS) {
    accumulator.hits.push({
      code: rule.code,
      entityType: rule.entityType,
      value,
      start,
      end,
      action: rule.action,
    });
  }
}

function applyRegexRule(accumulator: ScanAccumulator, rule: PrivacyRule): void {
  if (!rule.enabled || rule.kind !== 'regex' || !rule.pattern) return;
  const flags = normalizeFlags(rule.flags || 'g');
  const regex = compileRuleRegex(rule.pattern, flags);
  for (const match of accumulator.source.matchAll(regex)) {
    const value = match[0];
    if (!value) continue;
    const start = match.index ?? 0;
    recordHit(accumulator, rule, value, start, start + value.length);
    if (accumulator.hits.length >= MAX_HITS) break;
  }
}

function finalizeScan(accumulator: ScanAccumulator): PrivacyScanResult {
  let text = accumulator.source;
  const ordered = [...accumulator.replacements].sort((left, right) => right.start - left.start);
  for (const replacement of ordered) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  }
  return {
    text,
    redacted: accumulator.hits.length > 0,
    hits: [...accumulator.hits].sort((left, right) => left.start - right.start || left.end - right.end),
    placeholders: accumulator.placeholders,
  };
}

function execRegexRules(accumulator: ScanAccumulator, rules: PrivacyRule[]): void {
  for (const rule of rules) {
    if (accumulator.hits.length >= MAX_HITS) break;
    if (rule.kind === 'regex') applyRegexRule(accumulator, rule);
  }
}

export interface PromptEntity {
  code: string;
  value: string;
}

function parseEntitiesJson(raw: string): Array<Record<string, unknown>> {
  if (!raw) return [];
  let body = raw.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last <= first) return [];
  try {
    const parsed = JSON.parse(body.slice(first, last + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const entities = (parsed as { entities?: unknown }).entities;
    return Array.isArray(entities) ? (entities as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * prompt 规则抽取：只接受本次发送的 code，且 value 必须出现在原文（防幻觉）。
 * 无 LLM / 调用失败 / 返回非 JSON 均返回空数组，调用方回退正则。
 */
export async function extractPromptEntities(
  llm: LlmConfig | null,
  rules: PrivacyRule[],
  text: string,
): Promise<PromptEntity[]> {
  if (!llm || !llm.baseUrl || !llm.apiKey || !llm.model || rules.length === 0) return [];
  const ruleLines = rules.map((rule) => `- ${rule.code}: ${rule.instruction ?? rule.name}`).join('\n');
  const prompt =
    `待扫描文本：\n${text}\n\n` +
    `启用规则（code: 抽取要求）：\n${ruleLines}\n\n` +
    '请只返回 JSON，不要解释。格式：{"entities":[{"code":"规则 code","value":"原文中出现的片段"}]}。' +
    'value 必须逐字出现在待扫描文本中；不确定就不要返回。';
  const raw = await llmText(llm, {
    system: '你是隐私信息抽取器。严格依据给定规则从文本中抽取敏感片段，只输出 JSON。',
    prompt,
    maxChars: 2_000,
    timeoutMs: 20_000,
  });
  if (!raw) return [];
  const known = new Map(rules.map((rule) => [rule.code, rule]));
  const seen = new Set<string>();
  const result: PromptEntity[] = [];
  for (const item of parseEntitiesJson(raw)) {
    const code = typeof item.code === 'string' ? item.code.trim() : '';
    const value = typeof item.value === 'string' ? item.value : '';
    if (!code || !known.has(code)) continue;
    if (!value || value.length > 200 || !text.includes(value)) continue;
    const key = `${code}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ code, value });
    if (result.length >= 200) break;
  }
  return result;
}

async function applyPromptRules(
  accumulator: ScanAccumulator,
  rules: PrivacyRule[],
  llm: LlmConfig | null,
): Promise<void> {
  const promptRules = rules.filter((rule) => rule.enabled && rule.kind === 'prompt' && Boolean(rule.instruction));
  if (promptRules.length === 0 || !llm) return;
  const entities = await extractPromptEntities(llm, promptRules, accumulator.source);
  if (entities.length === 0) return;
  const byCode = new Map(promptRules.map((rule) => [rule.code, rule]));
  for (const entity of entities) {
    const rule = byCode.get(entity.code);
    if (!rule) continue;
    const value = entity.value;
    let from = 0;
    while (from <= accumulator.source.length) {
      const start = accumulator.source.indexOf(value, from);
      if (start < 0) break;
      recordHit(accumulator, rule, value, start, start + value.length);
      from = start + Math.max(1, value.length);
      if (accumulator.hits.length >= MAX_HITS) break;
    }
    if (accumulator.hits.length >= MAX_HITS) break;
  }
}

/** 同步扫描：只执行 regex 规则（预览 / 写入同步路径）。 */
export function scanText(
  db: DatabaseSync,
  partitionId: string | null,
  text: string,
  options: PrivacyScanOptions = {},
): PrivacyScanResult {
  if (!text) return { text: '', redacted: false, hits: [], placeholders: {} };
  const rules = options.rules ?? listPrivacyRules(db, partitionId ?? undefined);
  const accumulator = newScanAccumulator(text);
  execRegexRules(accumulator, rules);
  return finalizeScan(accumulator);
}

/** 异步扫描：regex + prompt（需要 LLM 且调用方传入 allowPrompt=true，且分区开启了 privacyLlmEnabled）。 */
export async function scanTextAsync(
  db: DatabaseSync,
  partitionId: string | null,
  text: string,
  options: PrivacyScanOptions = {},
): Promise<PrivacyScanResult & { placeholderKinds: Record<string, string> }> {
  if (!text) return { text: '', redacted: false, hits: [], placeholders: {}, placeholderKinds: {} };
  const rules = options.rules ?? listPrivacyRules(db, partitionId ?? undefined);
  const accumulator = newScanAccumulator(text);
  execRegexRules(accumulator, rules);
  if (options.allowPrompt && options.llm) {
    await applyPromptRules(accumulator, rules, options.llm);
  }
  return { ...finalizeScan(accumulator), placeholderKinds: accumulator.placeholderKinds };
}

/* ------------------------------------------------------------------ */
/* 占位符协议                                                          */
/* ------------------------------------------------------------------ */

export interface ValidatedPlaceholders {
  /** 正文实际引用的 token（按首次出现顺序，去重） */
  tokens: string[];
  /** 规范化后的映射（仅保留字符串值） */
  mapping: Record<string, string>;
}

/**
 * 校验占位符映射：token 形如 `{{key}}`，key 为 `[A-Za-z0-9_-]{3,64}`；
 * 正文引用的每个 token 必须有映射；映射中未出现在正文的 key 忽略。
 */
export function validatePlaceholders(content: string, raw: unknown): ValidatedPlaceholders {
  const mapping: Record<string, string> = {};
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw engineErrors.validation('placeholders 必须是对象（key→value）');
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > MAX_PLACEHOLDER_MAPPING_KEYS) {
      throw engineErrors.validation(`placeholders 最多 ${MAX_PLACEHOLDER_MAPPING_KEYS} 项`);
    }
    for (const [key, value] of entries) {
      if (!PLACEHOLDER_KEY_RE.test(key)) {
        throw engineErrors.validation(`占位符 key 不合法：${key}（仅支持字母、数字、下划线、连字符，长度 3–64）`);
      }
      if (typeof value !== 'string') throw engineErrors.validation(`占位符 ${key} 的值必须是字符串`);
      if (!value.trim()) throw engineErrors.validation(`占位符 ${key} 的值不能为空`);
      if (value.length > MAX_PLACEHOLDER_VALUE_CHARS) {
        throw engineErrors.validation(`占位符 ${key} 的值最长 ${MAX_PLACEHOLDER_VALUE_CHARS} 字符`);
      }
      mapping[key] = value;
    }
  }
  const tokens = placeholderTokensOf(content);
  // 正文里出现但不符合 token 语法的 {{...}} 也要报错，避免用户以为已被保护。
  for (const match of content.matchAll(new RegExp(ANY_BRACES_RE.source, 'g'))) {
    const key = match[1] ?? '';
    if (!PLACEHOLDER_KEY_RE.test(key)) {
      throw engineErrors.validation(`正文中的占位符 {{${key}}} 不合法（key 仅支持字母、数字、下划线、连字符，长度 3–64）`);
    }
  }
  const missing = tokens.filter((token) => !Object.prototype.hasOwnProperty.call(mapping, token));
  if (missing.length > 0) {
    throw engineErrors.validation(`以下占位符缺少映射值：${missing.map((token) => `{{${token}}}`).join('、')}`);
  }
  return { tokens, mapping };
}

export interface WritePlaceholdersInput {
  partitionId: string;
  memoryId: string;
  content: string;
  /** 调用方显式提交的映射 */
  mapping?: Record<string, string>;
  /** 扫描自动生成的映射（token→真实值） */
  generated?: Record<string, string>;
  kinds?: Record<string, string>;
  /** replace=整体覆盖（更新时）；merge=只补充缺失（NOOP/扫描追加） */
  mode?: 'replace' | 'merge';
}

/** 把正文引用的 token→value 落库（AES-256-GCM；未配置密钥时明文 encrypted=0）。 */
export function writeMemoryPlaceholders(db: DatabaseSync, input: WritePlaceholdersInput): number {
  const mode = input.mode ?? 'merge';
  const values: Record<string, string> = { ...(input.mapping ?? {}), ...(input.generated ?? {}) };
  const tokens = placeholderTokensOf(input.content);
  if (mode === 'replace') db.prepare('DELETE FROM memory_placeholders WHERE memory_id = ?').run(input.memoryId);
  if (tokens.length === 0) return 0;
  const key = encryptionKeyFromEnv();
  const at = nowIso();
  const insert = db.prepare(
    `INSERT INTO memory_placeholders
       (id, partition_id, memory_id, placeholder, value_cipher, encrypted, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_id, placeholder) DO NOTHING`,
  );
  let written = 0;
  for (const token of tokens) {
    const value = values[token];
    if (value === undefined) continue;
    const cipher = encryptField(value, key);
    const result = insert.run(
      newId('ph'),
      input.partitionId,
      input.memoryId,
      token,
      cipher,
      key ? 1 : 0,
      input.kinds?.[token] ?? null,
      at,
    );
    written += Number(result.changes ?? 0);
  }
  return written;
}

/** 删除正文已不再引用的占位符映射（更新内容/重扫后清理）。 */
export function pruneMemoryPlaceholders(db: DatabaseSync, memoryId: string, content: string): number {
  const keep = new Set(placeholderTokensOf(content));
  const rows = db
    .prepare('SELECT placeholder FROM memory_placeholders WHERE memory_id = ?')
    .all(memoryId) as unknown as { placeholder: string }[];
  let removed = 0;
  const remove = db.prepare('DELETE FROM memory_placeholders WHERE memory_id = ? AND placeholder = ?');
  for (const row of rows) {
    if (keep.has(row.placeholder)) continue;
    removed += Number(remove.run(memoryId, row.placeholder).changes ?? 0);
  }
  return removed;
}

export function countMemoryPlaceholders(db: DatabaseSync, memoryId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memory_placeholders WHERE memory_id = ?').get(memoryId) as unknown as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}

/** 批量补充 placeholderCount（列表/检索避免 N+1）。 */
export function withPlaceholderCounts<T extends Memory>(db: DatabaseSync, memories: T[]): T[] {
  if (memories.length === 0) return memories;
  const ids = [...new Set(memories.map((memory) => memory.id))];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT memory_id, COUNT(*) AS c FROM memory_placeholders
        WHERE memory_id IN (${placeholders}) GROUP BY memory_id`,
    )
    .all(...ids) as unknown as { memory_id: string; c: number }[];
  const counts = new Map(rows.map((row) => [row.memory_id, row.c]));
  return memories.map((memory) => ({ ...memory, placeholderCount: counts.get(memory.id) ?? 0 }));
}

/** 读取占位符列表：默认只返回 key/kind/encrypted；reveal=true 时解密 value。 */
export function listMemoryPlaceholders(
  db: DatabaseSync,
  partitionId: string,
  memoryId: string,
  reveal = false,
): MemoryPlaceholder[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_placeholders
        WHERE partition_id = ? AND memory_id = ?
        ORDER BY rowid ASC`,
    )
    .all(partitionId, memoryId) as unknown as PlaceholderRow[];
  const key = reveal ? encryptionKeyFromEnv() : null;
  return rows.map((row) => {
    const placeholder: MemoryPlaceholder = {
      placeholder: row.placeholder,
      ...(row.kind ? { kind: row.kind } : {}),
      encrypted: row.encrypted === 1,
    };
    if (reveal) placeholder.value = decryptField(row.value_cipher, key);
    return placeholder;
  });
}

function tokenValuesForMemory(db: DatabaseSync, partitionId: string, memoryId: string): Map<string, string> {
  const rows = db
    .prepare('SELECT placeholder, value_cipher FROM memory_placeholders WHERE partition_id = ? AND memory_id = ?')
    .all(partitionId, memoryId) as unknown as { placeholder: string; value_cipher: string }[];
  const values = new Map<string, string>();
  for (const row of rows) {
    try {
      values.set(row.placeholder, decryptField(row.value_cipher));
    } catch {
      // 解密失败（密钥轮换/未配置）时保留 token，避免阻塞 brief/context。
    }
  }
  return values;
}

/** 把一组记忆正文里的 {{token}} 替换为真实值（brief/context 注入前调用）。 */
export function resolveMemoryPlaceholders(db: DatabaseSync, partitionId: string, memories: Memory[]): Memory[] {
  return memories.map((memory) => {
    if (!memory.content.includes('{{')) return memory;
    const values = tokenValuesForMemory(db, partitionId, memory.id);
    if (values.size === 0) return memory;
    let content = memory.content;
    for (const [token, value] of values) {
      content = content.split(`{{${token}}}`).join(value);
    }
    return content === memory.content ? memory : { ...memory, content };
  });
}

/* ------------------------------------------------------------------ */
/* 应用到记忆（写管线 / job / dream / rescan 共用）                     */
/* ------------------------------------------------------------------ */

export interface PrivacyApplyResult {
  scanned: boolean;
  changed: boolean;
  hits: PrivacyScanHit[];
  placeholders: Record<string, string>;
  placeholderKinds: Record<string, string>;
  content: string;
}

function promptRuleCount(db: DatabaseSync, partitionId: string): number {
  return listPrivacyRules(db, partitionId).filter((rule) => rule.enabled && rule.kind === 'prompt').length;
}

/** 是否需要入队 privacy job：总开关 basic + 开启 LLM 隐私 + 存在启用的 prompt 规则。 */
export function privacyJobNeeded(db: DatabaseSync, partitionId: string): boolean {
  const partition = findPartitionById(db, partitionId);
  if (!partition) return false;
  const settings = parseSettings(partition.settings);
  if (settings.piiRedaction !== 'basic' || !settings.privacyLlmEnabled) return false;
  return promptRuleCount(db, partitionId) > 0;
}

function emptyResult(content: string): PrivacyApplyResult {
  return { scanned: false, changed: false, hits: [], placeholders: {}, placeholderKinds: {}, content };
}

function buildMetadata(row: MemoryRow, content: string, hits: number): string {
  const metadata = (() => {
    try {
      const value = JSON.parse(row.metadata) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  if (hits > 0) metadata.piiRedacted = true;
  const count = countPlaceholderTokens(content);
  if (count > 0) metadata.placeholderCount = count;
  else delete metadata.placeholderCount;
  return JSON.stringify(metadata);
}

function persistPrivacyScan(
  db: DatabaseSync,
  row: MemoryRow,
  scan: PrivacyScanResult & { placeholderKinds?: Record<string, string> },
  reason: string,
): PrivacyApplyResult {
  const at = nowIso();
  if (!scan.redacted && scan.text === row.content) {
    db.prepare('UPDATE memories SET privacy_scanned_at = ? WHERE id = ?').run(at, row.id);
    return { ...emptyResult(row.content), scanned: true };
  }
  return tx(db, () => {
    const latest = db.prepare('SELECT * FROM memories WHERE id = ?').get(row.id) as unknown as MemoryRow | undefined;
    if (!latest) return { ...emptyResult(row.content), scanned: true };
    const metadata = buildMetadata(latest, scan.text, scan.hits.length);
    db.prepare(
      `UPDATE memories
          SET content = ?, normalized_hash = ?, embedding = ?, embedding_model = ?, dim = ?,
              metadata = ?, privacy_scanned_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      scan.text,
      // 与写管线保持一致：content 变化必须重算内容哈希与 embedding
      memoryContentHash(scan.text),
      embeddingToBlob(embedText(scan.text)),
      EMBEDDING_MODEL,
      EMBEDDING_DIM,
      metadata,
      at,
      at,
      latest.id,
    );
    writeMemoryPlaceholders(db, {
      partitionId: latest.partition_id,
      memoryId: latest.id,
      content: scan.text,
      generated: scan.placeholders,
      kinds: scan.placeholderKinds,
      mode: 'merge',
    });
    pruneMemoryPlaceholders(db, latest.id, scan.text);
    const finalCount = countMemoryPlaceholders(db, latest.id);
    if (finalCount > 0) {
      const merged = (() => {
        try {
          return JSON.parse(metadata) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      merged.placeholderCount = finalCount;
      db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(merged), latest.id);
    }
    writeHistory(db, {
      partitionId: latest.partition_id,
      personId: latest.person_id,
      memoryId: latest.id,
      event: 'PRIVACY',
      oldContent: latest.content,
      newContent: scan.text,
      actor: { type: 'system', id: 'privacy', label: '隐私规则扫描' },
      reason,
      meta: {
        hits: scan.hits.length,
        codes: [...new Set(scan.hits.map((hit) => hit.code))],
        kinds: [...new Set(scan.hits.map((hit) => hit.entityType))],
        placeholders: Object.keys(scan.placeholders).length,
      },
      createdAt: at,
    });
    return {
      scanned: true,
      changed: scan.text !== latest.content,
      hits: scan.hits,
      placeholders: scan.placeholders,
      placeholderKinds: scan.placeholderKinds ?? {},
      content: scan.text,
    };
  });
}


function settingsFor(db: DatabaseSync, partitionId: string) {
  const partition = findPartitionById(db, partitionId);
  if (!partition) return null;
  return parseSettings(partition.settings);
}

/** 同步版：只跑 regex（写入路径；prompt 由 privacy job 异步补齐）。 */
export function applyPrivacyToMemorySync(
  db: DatabaseSync,
  partitionId: string,
  memoryId: string,
  options: { reason?: string } = {},
): PrivacyApplyResult {
  const settings = settingsFor(db, partitionId);
  if (!settings || settings.piiRedaction !== 'basic') {
    const row = db.prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?').get(partitionId, memoryId) as unknown as
      | MemoryRow
      | undefined;
    return emptyResult(row?.content ?? '');
  }
  const row = db.prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?').get(partitionId, memoryId) as unknown as
    | MemoryRow
    | undefined;
  if (!row) return emptyResult('');
  const scan = scanText(db, partitionId, row.content);
  return persistPrivacyScan(db, row, scan, options.reason ?? 'privacy:scan');
}

/** 异步版：regex + prompt（privacyLlmEnabled + LLM 可用时）。 */
export async function applyPrivacyToMemory(
  db: DatabaseSync,
  llm: LlmConfig | null,
  partitionId: string,
  memoryId: string,
  options: { reason?: string; allowPrompt?: boolean } = {},
): Promise<PrivacyApplyResult> {
  const settings = settingsFor(db, partitionId);
  const row = db.prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?').get(partitionId, memoryId) as unknown as
    | MemoryRow
    | undefined;
  if (!row) return emptyResult('');
  if (!settings || settings.piiRedaction !== 'basic') return emptyResult(row.content);
  const scan = await scanTextAsync(db, partitionId, row.content, {
    llm,
    allowPrompt: options.allowPrompt !== false && settings.privacyLlmEnabled,
  });
  return persistPrivacyScan(db, row, scan, options.reason ?? 'privacy:scan');
}

export interface PrivacyRescanResult {
  scanned: number;
  changed: number;
  placeholders: number;
  hits: number;
}

/** 管理端点重扫：按分区（可限定人）逐条应用 regex + prompt；幂等。 */
export async function rescanPrivacy(
  db: DatabaseSync,
  llm: LlmConfig | null,
  partitionId: string,
  options: { personId?: string; limit?: number } = {},
): Promise<PrivacyRescanResult> {
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)));
  const where = ['partition_id = ?'];
  const params: (string | number)[] = [partitionId];
  if (options.personId) {
    where.push('person_id = ?');
    params.push(options.personId);
  }
  const rows = db
    .prepare(`SELECT id FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as { id: string }[];
  let scanned = 0;
  let changed = 0;
  let placeholders = 0;
  let hits = 0;
  for (const row of rows) {
    const result = await applyPrivacyToMemory(db, llm, partitionId, row.id, { reason: 'privacy:rescan' });
    scanned += 1;
    if (result.changed) changed += 1;
    placeholders += Object.keys(result.placeholders).length;
    hits += result.hits.length;
  }
  return { scanned, changed, placeholders, hits };
}
