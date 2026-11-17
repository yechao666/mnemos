/**
 * 本地 embedding（确定性、零依赖、CJK 友好）。
 *
 * 思路：把文本拆成「特征」（英文词/词干、CJK 单字 + 双字 + 三字、少量同义概念词），
 * 用 FNV-1a 双哈希映射到 384 维，带符号累加后做 L2 归一化。
 * 同一文本永远得到同一向量；语义相近（共享字词/同义词）的文本余弦更高。
 *
 * v6.1 P0 不引入 sqlite-vec：向量落 memories.embedding（float32 LE BLOB），
 * 检索时在候选集上用内存余弦重排。
 */

export const EMBEDDING_MODEL = 'mnemos-hash-384';
export const EMBEDDING_DIM = 384;

/** 常见语义等价组：组内任意词都会额外贡献一个 canonical 特征（提升改写召回）。 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['喜欢', '偏好', '爱好', '偏爱', '中意', '爱喝', '爱吃'],
  ['讨厌', '不喜欢', '反感', '厌恶', '忌'],
  ['咖啡', '拿铁', '美式', '摩卡', '卡布奇诺'],
  ['工作', '职业', '岗位', '就职', '任职'],
  ['计划', '打算', '准备', '规划', '将要'],
  ['居住', '住在', '定居', '住'],
  ['电话', '手机', '联系方式', '号码'],
  ['名字', '姓名', '称呼', '改名', '昵称'],
  ['过敏', '忌口', '不耐受'],
  ['会议', '开会', '例会', '周会'],
  ['预算', '花费', '开销', '成本', '费用'],
  ['截止', '期限', 'deadline', '到期'],
  ['团队', '小组', '组内', '成员'],
  ['发布', '上线', '部署', '发版'],
  ['bug', '缺陷', '故障', '问题'],
  ['地址', '位置', '地点'],
  ['公司', '企业', '单位'],
  ['医院', '诊所', '就医'],
];

const SYNONYM_CANON = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0] ?? '';
  for (const word of group) SYNONYM_CANON.set(word.toLowerCase(), canonical);
}

const ASCII_WORD_RE = /[a-z0-9][a-z0-9_.+#-]*/g;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'you', 'your', 'not', 'but', 'all', 'can', 'will', 'would', 'should', 'about', 'into', 'than',
  'then', 'them', 'they', 'there', 'their', 'his', 'her', 'its', 'our', 'out', 'get', 'got',
]);

/** 32 位 FNV-1a（带 seed）。 */
function hash32(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 英文轻量词干：只处理最常见后缀，避免引入依赖。 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ['ingly', 'edly', 'ing', 'ers', 'ies', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

export interface TextFeatures {
  words: string[];
  cjkCharacters: string[];
}

/** 文本特征：英文词（含词干）与 CJK 连续片段。 */
export function extractTextFeatures(text: string): TextFeatures {
  const lower = text.normalize('NFKC').toLowerCase();
  const words: string[] = [];
  for (const match of lower.matchAll(ASCII_WORD_RE)) {
    const word = match[0];
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    words.push(word);
    const root = stem(word);
    if (root !== word && root.length >= 3) words.push(root);
  }
  const cjkCharacters: string[] = [];
  for (const match of lower.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    for (let index = 0; index < run.length; index += 1) cjkCharacters.push(run[index] ?? '');
    // 分隔符：避免跨句/跨标点拼出伪二元组
    cjkCharacters.push('');
  }
  return { words, cjkCharacters };
}

/**
 * 文本 → 归一化向量（Float32Array，长度 EMBEDDING_DIM）。
 * 空文本返回全零向量（调用方应按「无 embedding」处理）。
 */
export function embedText(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  const features = new Map<string, number>();

  const add = (feature: string, weight: number): void => {
    if (!feature) return;
    features.set(feature, (features.get(feature) ?? 0) + weight);
  };

  const { words, cjkCharacters } = extractTextFeatures(text);
  for (const word of words) {
    add(`w:${word}`, 1);
    const canonical = SYNONYM_CANON.get(word);
    if (canonical) add(`s:${canonical}`, 1.4);
    // 英文双词组合，缓解词序丢失
    if (words.length > 1) {
      const index = words.indexOf(word);
      const next = words[index + 1];
      if (next) add(`p:${word} ${next}`, 0.6);
    }
  }
  for (let index = 0; index < cjkCharacters.length; index += 1) {
    const char = cjkCharacters[index];
    if (!char) continue;
    add(`c:${char}`, 1);
    const bigram = char + (cjkCharacters[index + 1] ?? '');
    if (bigram.length === 2) {
      add(`b:${bigram}`, 0.9);
      const canonical = SYNONYM_CANON.get(bigram);
      if (canonical) add(`s:${canonical}`, 1.6);
    }
    const trigram = bigram + (cjkCharacters[index + 2] ?? '');
    if (trigram.length === 3) add(`t:${trigram}`, 0.45);
  }
  for (const [feature, weight] of features) {
    const first = hash32(feature, 0x9e3779b9);
    const second = hash32(feature, 0x85ebca6b);
    const index = first % EMBEDDING_DIM;
    const sign = (second & 1) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  }

  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    norm += value * value;
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = (vector[index] ?? 0) * scale;
    }
  }
  return vector;
}

/** 兼容别名：v5/v6.1 文档里也可能写作 embed / cosineSimilarity。 */
export const embed = embedText;
export const EMBEDDING_DIMENSION = EMBEDDING_DIM;

/** 余弦相似度：维度不一致/空向量返回 0；结果裁剪到 [-1,1]。 */
export function cosine(a: Float32Array | null | undefined, b: Float32Array | null | undefined): number {
  if (!a || !b) return 0;
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.min(1, Math.max(-1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

/** 兼容别名。 */
export const cosineSimilarity = cosine;

/** Float32Array → little-endian BLOB（SQLite BLOB 存储）。 */
export function embeddingToBlob(vector: Float32Array): Uint8Array {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * 4);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** BLOB → Float32Array；长度非法返回 null（视为无 embedding）。 */
export function blobToEmbedding(blob: Uint8Array | Buffer | ArrayBuffer | null | undefined): Float32Array | null {
  if (!blob) return null;
  let bytes: Uint8Array;
  if (blob instanceof ArrayBuffer) bytes = new Uint8Array(blob);
  else bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}
