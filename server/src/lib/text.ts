/**
 * 文本归一化与内容哈希：写入去重、迁移回填共用同一算法。
 * 归一化 = 小写、去空白、去常见中英文标点；哈希 = sha256(归一化文本)。
 */
import { createHash } from 'node:crypto';

const PUNCTUATION = /[，。！？；：、,.!?;:'"“”‘’()（）[\]【】<>《》\-—_/\\|·~`@#$%^&*+=]/g;

export function normalizeMemoryContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, '').replace(PUNCTUATION, '');
}

export function memoryContentHash(content: string): string {
  return createHash('sha256').update(normalizeMemoryContent(content), 'utf8').digest('hex');
}
