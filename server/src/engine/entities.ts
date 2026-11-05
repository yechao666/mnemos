/**
 * 规则式实体抽取：人名 / 组织 / 产品 / 技术 / 时间 / 地点。
 *
 * 做法：
 * - 人名：常见姓氏 + 称谓，或「叫/和/请 + 姓名」「句首姓名 + 谓语」语境；
 * - 组织：后缀（公司/集团/团队/实验室…）向前扫名词短语，辅以「公司为…」显式语境；
 * - 产品/技术：技术词表、英文专名（相邻大写词合并）、引号内术语；
 * - 时间：日期、相对时间、时段；地点：城市/国家表 + 行政区后缀。
 *
 * 同名跨类型去重后按 (类型, 归一化名) 聚合，给出 0..1 显著度。纯函数、确定性。
 */

import { normalizeText } from './tokenize.ts';
import {
  ENGLISH_COMMON,
  ENTITY_SALIENCE,
  LOCATION_PREFIX_BLACKLIST,
  LOCATION_SUFFIX,
  NAME_BLACKLIST,
  ORG_PREFIX_BLACKLIST,
  ORG_SUFFIXES,
  PERSON_TITLES,
  PLACES,
  SURNAMES,
  TECH_TERMS,
  TIME_PATTERNS,
} from './lexicon.ts';

export type EntityType = 'person' | 'organization' | 'product' | 'technology' | 'time' | 'location' | 'concept';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  salience: number;
}

/** 同名跨类型时的保留优先级（越靠前越优先）。 */
export const ENTITY_TYPE_PRIORITY: EntityType[] = ['person', 'organization', 'technology', 'location', 'product', 'time', 'concept'];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function round(value: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

/** 实体归一化键（用于 entities.normalized 与去重）。 */
export function normalizeEntityName(name: string): string {
  return normalizeText(name).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* 正则（模块级编译一次）                                              */
/* ------------------------------------------------------------------ */

const SURNAME_CLASS = SURNAMES.join('');
const TITLE_ALT = PERSON_TITLES.join('|');
/** 张伟老师 / 李经理 */
const TITLE_RE = new RegExp(`([${SURNAME_CLASS}])([\\u4e00-\\u9fff]{0,2})(${TITLE_ALT})`, 'g');
/** 叫林薇 / 和张伟 / 由王芳负责 */
const NAME_CONTEXT_RE = new RegExp(
  `(?:叫|名叫|名字是|是|和|与|跟|向|给|请|谢谢|找|由|让)([${SURNAME_CLASS}][\\u4e00-\\u9fff]{1,2})(?=负责|主导|管理|说|觉得|认为|在|的|和|与|，|,|。|；|;|$)`,
  'g',
);
/** 句首人名：林薇负责… / 刘思远希望… */
const NAME_INITIAL_RE = new RegExp(
  `(?:^|[。！？；;，,\\s])([${SURNAME_CLASS}][\\u4e00-\\u9fff]{1,2})(?=负责|主导|管理|是|在|说|将|要|会|的|开发|设计|带领|加入|目前|工作|希望|要求|偏好|喜欢|爱|习惯|关注|反馈|计划|接受|拒绝|使用|认为|觉得|需要|不|只)`,
  'g',
);
/** 「公司为杭州星野零售」「任职于…」这类显式组织语境 */
const ORG_OF_RE = /(?:公司为|公司是|公司叫|就职于|任职于|供职于|入职|来自)([\u4e00-\u9fffA-Za-z0-9]{2,12})/g;
const ORG_EN_RE = /\b([A-Z][A-Za-z0-9&.-]{1,}(?:\s+[A-Z][A-Za-z0-9&.-]{1,}){0,2})\s+(?:Inc|Ltd|Corp|LLC|GmbH|Labs?|Team|Dept)\b/g;
/** 英文专名（相邻首字母大写词合并，如 Aurora Cloud） */
const PROPER_NOUN_RE = /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*\b/g;
/** 引号内术语 */
const QUOTED_RE = /[「『"“]([^」』"”]{1,40})[」』"”]/g;

/** 组织/地点前缀的边界字符：遇到这些字符即认为名词短语开始。 */
const BOUNDARY_CHARS = new Set(
  Array.from('，。！？；;：:、,.!?()（）「」『』“”"\' \t\n是我你他她它们这那个了着和与跟向给对为于从把被让由及或而但并就都也还又很最更不没将要会能可请找至在的有个该本'),
);

const TECH_KEYS = Object.keys(TECH_TERMS).sort((a, b) => b.length - a.length);
const TECH_RE = new RegExp(`(?<![a-z0-9])(${TECH_KEYS.map(escapeRegExp).join('|')})(?![a-z0-9])`, 'gi');
const TIME_RES = TIME_PATTERNS.map((source) => new RegExp(source, 'g'));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RawEntity {
  name: string;
  type: EntityType;
  index: number;
}

function pushMatch(results: RawEntity[], value: string, type: EntityType, index: number): void {
  const name = value.trim();
  if (name.length < 2) return;
  results.push({ name, type, index });
}

function collect(re: RegExp, text: string, results: RawEntity[], type: EntityType): void {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    pushMatch(results, match[0], type, match.index);
    if (match[0].length === 0) re.lastIndex++;
  }
}

const ORG_SUFFIXES_SORTED = [...ORG_SUFFIXES].sort((a, b) => b.length - a.length);
const LOCATION_SUFFIXES_SORTED = LOCATION_SUFFIX.split('|').sort((a, b) => b.length - a.length);

interface SuffixMatch {
  value: string;
  suffix: string;
  index: number;
}

/** 从后缀位置向前扫描名词短语：遇边界字符或超过 maxPrefix 即停止（比贪婪前缀正则准得多）。 */
function scanBySuffix(text: string, suffixes: string[], maxPrefix: number): SuffixMatch[] {
  const out: SuffixMatch[] = [];
  for (let i = 0; i < text.length; i++) {
    let suffix = '';
    for (const candidate of suffixes) {
      if (text.startsWith(candidate, i)) {
        suffix = candidate;
        break;
      }
    }
    if (!suffix) continue;
    let start = i;
    let count = 0;
    while (start > 0 && count < maxPrefix && !BOUNDARY_CHARS.has(text[start - 1])) {
      start--;
      count++;
    }
    if (count < 2) continue;
    out.push({ value: text.slice(start, i + suffix.length), suffix, index: start });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 各类型抽取                                                          */
/* ------------------------------------------------------------------ */

function extractPersons(text: string, results: RawEntity[]): void {
  TITLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TITLE_RE.exec(text)) !== null) {
    if (!NAME_BLACKLIST.has(match[0])) pushMatch(results, match[0], 'person', match.index);
  }
  for (const pattern of [NAME_CONTEXT_RE, NAME_INITIAL_RE]) {
    const re = new RegExp(pattern.source, 'g');
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = re.exec(text)) !== null) {
      const name = nameMatch[1];
      if (name && !NAME_BLACKLIST.has(name)) pushMatch(results, name, 'person', nameMatch.index + nameMatch[0].length - name.length);
    }
  }
}

function extractOrganizations(text: string, results: RawEntity[]): void {
  for (const item of scanBySuffix(text, ORG_SUFFIXES_SORTED, 8)) {
    const prefix = item.value.slice(0, item.value.length - item.suffix.length);
    if (prefix.length < 2) continue;
    if (prefix.includes('的')) continue;
    if (ORG_PREFIX_BLACKLIST.some((word) => prefix.startsWith(word))) continue;
    if (NAME_BLACKLIST.has(prefix)) continue;
    pushMatch(results, item.value, 'organization', item.index);
  }
  ORG_OF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ORG_OF_RE.exec(text)) !== null) {
    const raw = match[1].replace(/[的在是了于]+$/, '');
    if (raw.length >= 2) pushMatch(results, raw, 'organization', match.index + match[0].length - raw.length);
  }
  collect(ORG_EN_RE, text, results, 'organization');
}

function extractTechnologies(text: string, results: RawEntity[]): void {
  TECH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TECH_RE.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    pushMatch(results, TECH_TERMS[key] ?? match[1], 'technology', match.index);
  }
}

function extractProducts(text: string, results: RawEntity[], occupied: { start: number; end: number }[]): void {
  QUOTED_RE.lastIndex = 0;
  let quoted: RegExpExecArray | null;
  while ((quoted = QUOTED_RE.exec(text)) !== null) {
    pushMatch(results, quoted[1], 'product', quoted.index + 1);
  }
  PROPER_NOUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROPER_NOUN_RE.exec(text)) !== null) {
    const value = match[0];
    const words = value.split(/\s+/);
    const head = words[0];
    if (head.length < 3) continue;
    if (ENGLISH_COMMON.has(head.toLowerCase())) continue;
    if (words.every((word) => ENGLISH_COMMON.has(word.toLowerCase()))) continue;
    const start = match.index;
    const end = start + value.length;
    // 与已识别的技术词重叠时不再重复标注为「产品」
    if (occupied.some((span) => start < span.end && end > span.start)) continue;
    pushMatch(results, value, 'product', start);
  }
}

function extractTimes(text: string, results: RawEntity[]): void {
  for (const re of TIME_RES) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      pushMatch(results, match[0], 'time', match.index);
      if (match[0].length === 0) re.lastIndex++;
    }
  }
}

function extractLocations(text: string, results: RawEntity[]): void {
  for (const place of PLACES) {
    let from = 0;
    for (let i = 0; i < 4; i++) {
      const at = text.indexOf(place, from);
      if (at < 0) break;
      pushMatch(results, place, 'location', at);
      from = at + place.length;
    }
  }
  for (const item of scanBySuffix(text, LOCATION_SUFFIXES_SORTED, 6)) {
    const prefix = item.value.slice(0, item.value.length - item.suffix.length);
    if (prefix.length < 2) continue;
    if (LOCATION_PREFIX_BLACKLIST.some((word) => prefix.startsWith(word))) continue;
    if (prefix.includes('的')) continue;
    pushMatch(results, item.value, 'location', item.index);
  }
}

/** 同类型区间重叠时保留更长的匹配（例如「北京市」优先于「北京」）。 */
function dedupeSpans(raw: RawEntity[]): RawEntity[] {
  const byType = new Map<EntityType, RawEntity[]>();
  for (const entity of raw) {
    const list = byType.get(entity.type) ?? [];
    list.push(entity);
    byType.set(entity.type, list);
  }
  const kept: RawEntity[] = [];
  for (const list of byType.values()) {
    list.sort((a, b) => a.index - b.index || b.name.length - a.name.length);
    let lastEnd = -1;
    for (const entity of list) {
      const end = entity.index + entity.name.length;
      if (entity.index < lastEnd) continue;
      kept.push(entity);
      lastEnd = end;
    }
  }
  return kept;
}

/** 实体抽取：按 (归一化名) 去重后聚合，输出带显著度的实体列表。 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (!text) return [];
  const raw: RawEntity[] = [];
  extractPersons(text, raw);
  extractOrganizations(text, raw);
  extractTechnologies(text, raw);
  extractTimes(text, raw);
  extractLocations(text, raw);
  const techSpans = raw
    .filter((entity) => entity.type === 'technology')
    .map((entity) => ({ start: entity.index, end: entity.index + entity.name.length }));
  extractProducts(text, raw, techSpans);

  const merged = new Map<string, { name: string; type: EntityType; count: number; base: number }>();
  for (const entity of dedupeSpans(raw)) {
    const normalized = normalizeEntityName(entity.name);
    const existing = merged.get(normalized);
    if (existing) {
      // 同名跨类型（如引号内公司名同时被标为产品）保留类型优先级更高者
      if (ENTITY_TYPE_PRIORITY.indexOf(entity.type) < ENTITY_TYPE_PRIORITY.indexOf(existing.type)) {
        existing.type = entity.type;
        existing.base = ENTITY_SALIENCE[entity.type] ?? 0.5;
      }
      existing.count++;
      continue;
    }
    merged.set(normalized, { name: entity.name, type: entity.type, count: 1, base: ENTITY_SALIENCE[entity.type] ?? 0.5 });
  }
  return [...merged.values()]
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      salience: round(clamp(entry.base + Math.min(0.15, (entry.count - 1) * 0.05), 0.1, 1), 2),
    }))
    .sort((a, b) => b.salience - a.salience || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
