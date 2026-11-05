/**
 * 中英文混合分词器 —— BM25 词项与向量词特征的唯一来源。
 *
 * 规则：
 * - 文本先做 NFKC 规整（全角→半角）并小写化；
 * - CJK 连续串：先出二元组（bigram），再出单字；
 * - 拉丁/数字：按非字母数字边界切词；
 * - 过滤中英文停用词，拉丁单字母丢弃；
 * - `tokenize` 返回去重后的词项（首次出现顺序），`termFrequencies` 返回含词频的原始切分。
 *
 * 全程纯函数、确定性、零依赖（无第三方库、无随机数）。
 */

/** 原始 token 上限：防止超长文本拖慢索引（确定性截断）。 */
const MAX_RAW_TOKENS = 2048;
/** 去重词项上限（每条记忆写入 memory_terms 的行数上限）。 */
const MAX_UNIQUE_TERMS = 512;

/** 中文停用词（单字与常见虚词二元组）。 */
const ZH_STOPWORDS = [
  '的', '了', '着', '过', '是', '在', '和', '与', '及', '或', '而', '也', '都', '就', '还',
  '又', '很', '太', '更', '最', '不', '没', '别', '被', '把', '让', '给', '对', '从', '到',
  '向', '于', '以', '为', '之', '其', '则', '但', '并', '且', '等', '呀', '啊', '吧', '呢',
  '吗', '哦', '嗯', '哈', '啦', '嘛', '哇', '我', '你', '您', '他', '她', '它', '咱',
  '我们', '你们', '他们', '她们', '它们', '咱们', '这个', '那个', '这些', '那些', '这里',
  '那里', '这样', '那样', '什么', '怎么', '为什么', '哪些', '哪个', '因为', '所以', '但是',
  '如果', '虽然', '然后', '还是', '已经', '正在', '现在', '今天', '明天', '昨天', '时候',
  '以及', '或者', '并且', '不过', '就是', '还有', '没有', '不是', '不能', '不会', '不要',
  '知道', '觉得', '需要', '应该', '可能', '自己', '大家', '别人', '东西', '一个', '一些',
  '一下', '一直', '一定', '非常', '特别', '比较', '其实', '真的', '对于', '关于', '由于',
  '通过', '根据', '按照', '作为', '成为', '进行', '开始', '方面', '目前', '一般', '稍微',
  '可以', '使用', '用于', '这种', '那种', '所有', '每个', '整个', '其他', '另外', '同时',
  '之后', '之前', '以后', '以前', '当中', '其中', '如何', '是否', '这样', '那样',
];

/** 英文停用词。 */
const EN_STOPWORDS = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'done', 'have', 'has', 'had', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'you', 'he', 'she', 'we', 'they', 'me', 'us', 'them', 'my', 'your', 'his', 'her', 'our',
  'their', 'as', 'so', 'not', 'no', 'yes', 'can', 'could', 'will', 'would', 'should', 'may',
  'might', 'must', 'just', 'about', 'into', 'over', 'after', 'before', 'than', 'too', 'very',
  'also', 'there', 'here', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'any', 'some', 'more', 'most', 'other', 'such', 'only', 'own', 'same', 'up', 'down',
  'out', 'off', 'again', 'once', 's', 't', 'don', 'now', 'am', 'get', 'got', 'make', 'made',
  'like', 'want', 'need', 'one', 'two', 'well', 'really', 'quite', 'both', 'each', 'few',
];

const STOPWORDS = new Set<string>([...ZH_STOPWORDS, ...EN_STOPWORDS]);
/** 单字停用词：两个都是虚词的二元组（如「的了」「是在」）同样没有检索价值。 */
const ZH_CHAR_STOPWORDS = new Set(ZH_STOPWORDS.filter((word) => word.length === 1));

/** 一个「词段」：连续 CJK，或连续拉丁字母/数字。 */
const SEGMENT_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9\u00c0-\u024f]+/g;

/** 文本规整：NFKC（全角→半角）+ 小写 + 空白折叠。 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isCjkSegment(segment: string): boolean {
  const code = segment.charCodeAt(0);
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

function keep(token: string): boolean {
  if (token.length === 0) return false;
  if (STOPWORDS.has(token)) return false;
  // 单个拉丁字母几乎没有检索价值（数字保留）
  if (token.length === 1 && token >= 'a' && token <= 'z') return false;
  return true;
}

/** 顺序切分（保留重复），最多 cap 个 token。 */
function rawTokens(text: string, cap: number): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const out: string[] = [];
  SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(normalized)) !== null) {
    const segment = match[0];
    if (isCjkSegment(segment)) {
      const chars = Array.from(segment);
      // 二元组优先：中文检索以双字词为主信号
      for (let i = 0; i + 1 < chars.length; i++) {
        if (ZH_CHAR_STOPWORDS.has(chars[i]) && ZH_CHAR_STOPWORDS.has(chars[i + 1])) continue;
        const bigram = chars[i] + chars[i + 1];
        if (keep(bigram)) out.push(bigram);
      }
      for (const char of chars) {
        if (keep(char)) out.push(char);
      }
    } else if (keep(segment)) {
      out.push(segment);
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

/** 分词：返回去重后的词项（首次出现顺序）。 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of rawTokens(text, MAX_RAW_TOKENS)) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
    if (result.length >= MAX_UNIQUE_TERMS) break;
  }
  return result;
}

/** 词频统计：term → 出现次数（用于 memory_terms.tf）。 */
export function termFrequencies(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of rawTokens(text, MAX_RAW_TOKENS)) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

/** 词项权重排序（供检索用：优先保留高频/长词）。 */
export function rankTerms(text: string, limit = 12): string[] {
  const freq = termFrequencies(text);
  return [...freq.entries()]
    .map(([term, tf]) => ({ term, tf, weight: tf * (term.length > 1 ? 1.5 : 1) }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((entry) => entry.term);
}
