/**
 * 规则式事实抽取（离线、确定性；后续可替换为 LLM 抽取，接口不变）。
 *
 * 流程：消息 → 分句 → 噪声过滤（寒暄/过短/疑问）→ 代词归一（我→用户、你→助手）
 *      → 分类（词典打分）→ 重要度/置信度 → 实体（entities.ts）→ 同句实体关系。
 *
 * 所有规则均可在 lexicon.ts 中扩充；同一输入必得同一输出（无随机、无时间依赖）。
 */

import type { ChatMessage, MemoryCategory } from '../../../shared/src/types.ts';
import { normalizeText } from './tokenize.ts';
import { extractEntities, type EntityType, type ExtractedEntity } from './entities.ts';
import {
  ASSERTIVE_RE,
  ASSISTANT_FILLER_RE,
  CATEGORY_LEXICON,
  CATEGORY_PRIORITY,
  EMPHASIS_RE,
  GREETING_RE,
  HEDGE_RE,
  IMPORTANCE_BASE,
  RELATION_FALLBACK,
  RELATION_FALLBACK_WEIGHT,
  RELATION_PATTERNS,
} from './lexicon.ts';

export { extractEntities, normalizeEntityName } from './entities.ts';
export type { EntityType, ExtractedEntity } from './entities.ts';

export interface ExtractedRelation {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface ExtractedFact {
  /** 归一化后的简洁事实句 */
  content: string;
  /** 抽取来源的原始句子 */
  raw: string;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export interface ExtractionContext {
  /** 「我」归一化后的用户标识（默认「用户」） */
  userLabel?: string;
  /** 「你」归一化后的助手标识（默认「助手」） */
  assistantLabel?: string;
  /** 处理文本时假定的说话方（默认 user） */
  role?: 'user' | 'assistant';
}

/** 单条事实最多产生的边数（防止长句两两组合爆炸）。 */
const MAX_RELATIONS_PER_FACT = 12;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function round(value: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

/* ------------------------------------------------------------------ */
/* 关系抽取                                                            */
/* ------------------------------------------------------------------ */

/** 同一事实内实体两两关系：按实体间动词模式给标签，兜底「相关」。 */
export function extractRelations(text: string, entities: ExtractedEntity[]): ExtractedRelation[] {
  if (entities.length < 2) return [];
  const positioned = entities
    .map((entity) => ({ entity, at: text.indexOf(entity.name) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at || b.entity.name.length - a.entity.name.length || a.entity.name.localeCompare(b.entity.name))
    .slice(0, 8);
  if (positioned.length < 2) return [];

  const relations: ExtractedRelation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < positioned.length; i++) {
    for (let j = i + 1; j < positioned.length; j++) {
      const source = positioned[i];
      const target = positioned[j];
      const between = text.slice(source.at + source.entity.name.length, target.at);
      let relation = RELATION_FALLBACK;
      let weight = RELATION_FALLBACK_WEIGHT;
      for (const pattern of RELATION_PATTERNS) {
        if (pattern.pattern.test(between)) {
          relation = pattern.relation;
          weight = pattern.weight;
          break;
        }
      }
      // 时间/地点与实体之间若无明确动词，不生成噪声边
      if (relation === RELATION_FALLBACK && (source.entity.type === 'time' || target.entity.type === 'time')) continue;
      // 地点/时间只与相邻实体建边，避免长句里出现「深圳负责 API」这类显著错误的边
      const structural =
        source.entity.type === 'location' ||
        source.entity.type === 'time' ||
        target.entity.type === 'location' ||
        target.entity.type === 'time';
      if (structural && j !== i + 1) continue;
      // 长句里非相邻实体之间的兜底边噪声过大，只在相邻或短句时保留
      if (relation === RELATION_FALLBACK && j !== i + 1 && positioned.length > 3) continue;
      const key = `${source.entity.name}|${target.entity.name}|${relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({ source: source.entity.name, target: target.entity.name, relation, weight });
      if (relations.length >= MAX_RELATIONS_PER_FACT) return relations;
    }
  }
  return relations;
}

/* ------------------------------------------------------------------ */
/* 分类与打分                                                          */
/* ------------------------------------------------------------------ */

function keywordWeight(keyword: string): number {
  const length = keyword.length;
  return /^[a-z]+$/.test(keyword) ? 0.8 + Math.min(1.2, length * 0.2) : 0.8 + Math.min(1.2, length * 0.25);
}

function countOccurrences(text: string, keyword: string): number {
  let count = 0;
  let from = 0;
  while (count < 2) {
    const at = text.indexOf(keyword, from);
    if (at < 0) break;
    count++;
    from = at + keyword.length;
  }
  return count;
}

/** 分类：词典打分，平局按 CATEGORY_PRIORITY，全无命中回退 fact。 */
export function classify(text: string): { category: MemoryCategory; score: number } {
  const normalized = normalizeText(text);
  let best: MemoryCategory = 'fact';
  let bestScore = 0;
  for (const category of CATEGORY_PRIORITY) {
    if (category === 'fact') continue;
    let score = 0;
    for (const keyword of CATEGORY_LEXICON[category]) {
      const hits = countOccurrences(normalized, keyword.toLowerCase());
      if (hits > 0) score += keywordWeight(keyword) * hits;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return { category: best, score: round(bestScore, 3) };
}

/** 重要度 / 置信度打分（0..1）。 */
export function scoreFact(
  text: string,
  category: MemoryCategory,
  entities: ExtractedEntity[],
): { importance: number; confidence: number } {
  let importance = IMPORTANCE_BASE[category];
  importance += Math.min(0.09, entities.length * 0.03);
  if (EMPHASIS_RE.test(text)) importance += 0.08;
  if (HEDGE_RE.test(text)) importance -= 0.06;
  if (ASSERTIVE_RE.test(text)) importance += 0.03;
  importance += Math.min(0.05, text.length / 400);
  importance = round(clamp(importance, 0.05, 0.98), 2);

  let confidence = 0.82;
  if (HEDGE_RE.test(text)) confidence -= 0.22;
  if (ASSERTIVE_RE.test(text)) confidence += 0.1;
  if (text.length < 8) confidence -= 0.08;
  if (/[?？]/.test(text)) confidence -= 0.1;
  confidence = round(clamp(confidence, 0.25, 0.98), 2);
  return { importance, confidence };
}

/* ------------------------------------------------------------------ */
/* 分句与事实构造                                                      */
/* ------------------------------------------------------------------ */

/** 按中英文句末标点分句（英文句点仅在后接大写起句时切分，避免拆开 Node.js）。 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/[。！？!?；;\n]+|(?<=[a-z0-9])\.(?=\s+[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isNoise(sentence: string, role: 'user' | 'assistant'): boolean {
  const trimmed = sentence.replace(/^[\s\-*•\d.、)）]+/, '').trim();
  if (!trimmed) return true;
  if (GREETING_RE.test(trimmed)) return true;
  if (/^[^\p{L}\p{N}]+$/u.test(trimmed)) return true;
  const meaningful = trimmed.replace(/\s+/g, '');
  if (meaningful.length < 4) return true;
  // 疑问句不是事实；纯客套应答也不入库
  if (/(吗|呢|嘛)[。.!！]?$/.test(trimmed) || /[?？]$/.test(trimmed)) return true;
  if (/^(谢谢|多谢|感谢|辛苦了|收到|明白|了解|好的|可以|没问题)/.test(trimmed) && meaningful.length <= 6) return true;
  if (role === 'assistant' && ASSISTANT_FILLER_RE.test(trimmed)) return true;
  return false;
}

/** 代词归一：用户说「我」→用户标识、「你」→助手；助手消息反之。 */
function normalizePronouns(sentence: string, role: 'user' | 'assistant', userLabel: string, assistantLabel: string): string {
  const pairs: [string, string][] =
    role === 'assistant'
      ? [['我们', assistantLabel], ['我', assistantLabel], ['你们', userLabel], ['你', userLabel], ['您', userLabel]]
      : [['我们', userLabel], ['我', userLabel], ['你们', assistantLabel], ['你', assistantLabel], ['您', assistantLabel]];
  let output = sentence;
  for (const [from, to] of pairs) output = output.split(from).join(to);
  return output;
}

function cleanSentence(sentence: string): string {
  return sentence
    .replace(/^(?:那个|嗯|呃|其实|然后|不过|所以)[，,、\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,、；;：:。.!！?？\-\s]+/, '')
    .replace(/[，,、；;：:。.!！?？\-\s]+$/, '')
    .trim();
}

function buildFact(sentence: string, role: 'user' | 'assistant', ctx: ExtractionContext): ExtractedFact | null {
  if (isNoise(sentence, role)) return null;
  const userLabel = ctx.userLabel || '用户';
  const assistantLabel = ctx.assistantLabel || '助手';
  const normalized = cleanSentence(normalizePronouns(sentence, role, userLabel, assistantLabel));
  if (!normalized) return null;
  // 助手自述（「助手可以帮你…」）对用户记忆没有价值
  if (role === 'assistant' && normalized.startsWith(assistantLabel)) return null;

  // 分类用原始句（保留「我叫」「我是」等第一人称线索），内容用归一化句
  const { category } = classify(sentence);
  const entities = extractEntities(normalized);
  const relations = extractRelations(normalized, entities);
  const { importance, confidence } = scoreFact(normalized, category, entities);
  return { content: normalized, raw: sentence.trim(), category, importance, confidence, entities, relations };
}

function mergeFact(target: ExtractedFact, incoming: ExtractedFact): void {
  target.importance = Math.max(target.importance, incoming.importance);
  target.confidence = Math.max(target.confidence, incoming.confidence);
  if (CATEGORY_PRIORITY.indexOf(incoming.category) < CATEGORY_PRIORITY.indexOf(target.category)) {
    target.category = incoming.category;
  }
  const entityKeys = new Set(target.entities.map((entity) => `${entity.type}|${normalizeText(entity.name)}`));
  for (const entity of incoming.entities) {
    const key = `${entity.type}|${normalizeText(entity.name)}`;
    if (entityKeys.has(key)) continue;
    entityKeys.add(key);
    target.entities.push(entity);
  }
  const relationKeys = new Set(target.relations.map((relation) => `${relation.source}|${relation.target}|${relation.relation}`));
  for (const relation of incoming.relations) {
    const key = `${relation.source}|${relation.target}|${relation.relation}`;
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    target.relations.push(relation);
  }
}

function addFact(facts: ExtractedFact[], fact: ExtractedFact): void {
  const key = normalizeText(fact.content);
  const existing = facts.find((item) => normalizeText(item.content) === key);
  if (existing) mergeFact(existing, fact);
  else facts.push(fact);
}

/** 消息列表 → 候选事实（user/assistant 均参与，助手的问答引导语会被过滤）。 */
export function extractFromMessages(messages: ChatMessage[], ctx: ExtractionContext = {}): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (!message.content || !message.content.trim()) continue;
    for (const sentence of splitSentences(message.content)) {
      const fact = buildFact(sentence, message.role, ctx);
      if (fact) addFact(facts, fact);
    }
  }
  return facts;
}

/** 纯文本 → 候选事实（按句切分；`infer=false` 时不走这里，原文单条入库）。 */
export function extractFromText(text: string, ctx: ExtractionContext = {}): ExtractedFact[] {
  return extractFromMessages([{ role: ctx.role ?? 'user', content: text }], ctx);
}
