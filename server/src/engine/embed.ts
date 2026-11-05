/**
 * 本地确定性文本嵌入（默认模型 `mnemos-hash-384`）。
 *
 * 方案：带符号的 feature hashing ——
 * - 词特征（分词结果）权重最高；
 * - 字符 2-gram / 3-gram 提供子词泛化；
 * - 每个特征经 FNV-1a 32 位哈希映射到 384 维中的一个维度，符号由二次哈希决定；
 * - 最后做 L2 归一化，便于余弦相似度直接比较。
 *
 * 同一文本必然得到同一向量；无网络、无随机、零依赖。
 * 注意：这是「词法哈希」嵌入，语义能力有限，但离线、可测试、可复现，
 * 后续可平滑替换为真实模型（接口保持不变）。
 */

import { normalizeText, tokenize } from './tokenize.ts';

/** 嵌入维度。 */
export const DIM = 384;
/** 默认嵌入模型标识（写入 memories.embedding_model）。 */
export const EMBEDDING_MODEL = 'mnemos-hash-384';

/** 参与嵌入的最大字符数，避免超长文本拖慢写入。 */
const MAX_EMBED_CHARS = 4000;
const WORD_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.65;
const BIGRAM_WEIGHT = 0.45;

/** FNV-1a 32 位哈希（确定性、快速、无 crypto 依赖）。 */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 把一个特征累加进向量：索引与符号分别来自两次哈希，降低相关性。 */
function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const index = hash32(feature) % DIM;
  const sign = (hash32(`${feature}#sign`) & 1) === 0 ? 1 : -1;
  vector[index] += sign * weight;
}

function l2Normalize(vector: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  if (sum <= 0) return;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
}

/** 文本 → 384 维单位向量（确定性）。 */
export function embedText(text: string): Float32Array {
  const vector = new Float32Array(DIM);
  if (!text) return vector;
  const normalized = normalizeText(text).slice(0, MAX_EMBED_CHARS);
  if (!normalized) return vector;

  // 1) 词特征
  for (const term of tokenize(normalized)) addFeature(vector, `w:${term}`, WORD_WEIGHT);

  // 2) 字符 n-gram（按空白切段，避免跨词边界产生噪声特征）
  for (const segment of normalized.split(' ')) {
    const chars = Array.from(segment);
    if (chars.length === 0) continue;
    for (let n = 2; n <= 3; n++) {
      const weight = n === 2 ? BIGRAM_WEIGHT : TRIGRAM_WEIGHT;
      for (let i = 0; i + n <= chars.length; i++) {
        addFeature(vector, `c${n}:${chars.slice(i, i + n).join('')}`, weight);
      }
    }
  }

  l2Normalize(vector);
  return vector;
}

/** Float32Array → BLOB（复制一份，避免与 SQLite 共享内存）。 */
export function vectorToBlob(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

/** BLOB → Float32Array（拷贝到对齐缓冲区，兼容任意 byteOffset）。 */
export function blobToVector(blob: Uint8Array | null | undefined): Float32Array {
  if (!blob || blob.byteLength < 4) return new Float32Array(0);
  const bytes = new Uint8Array(blob.byteLength);
  bytes.set(blob);
  const length = Math.floor(bytes.byteLength / 4);
  return new Float32Array(bytes.buffer, 0, length);
}

/** 余弦相似度：任一向量为零向量（或维度不一致）时返回 0。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  const value = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return value > 1 ? 1 : value < -1 ? -1 : value;
}
