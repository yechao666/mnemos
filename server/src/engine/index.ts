/**
 * 记忆引擎唯一公开入口。
 *
 * - createMemoryService(db, options?) → MemoryService（契约实现）
 * - 其余导出为引擎内部能力（分词/嵌入/抽取/检索），供 seed、脚本与测试复用。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryService } from '../../../shared/src/types.ts';
import { createMemoryService as createService, type MemoryServiceOptions } from './service.ts';

/** 创建记忆服务。`options.bus` 接入 SSE 实时流；`options.recordUsage` 让引擎自己写用量（默认 false）。 */
export function createMemoryService(db: DatabaseSync, options: MemoryServiceOptions = {}): MemoryService {
  return createService(db, options);
}

export type { MemoryServiceOptions } from './service.ts';
export type { EntityType, ExtractedEntity, ExtractedFact, ExtractedRelation, ExtractionContext } from './extract.ts';
export type { LegacyScopeFields, PersistMemoryInput } from './store.ts';
export type { MemoryScope } from '../../../shared/src/types.ts';

export { tokenize, termFrequencies, normalizeText, rankTerms } from './tokenize.ts';
export { DIM, EMBEDDING_MODEL, embedText, vectorToBlob, blobToVector, cosine } from './embed.ts';
export { extractFromMessages, extractFromText, extractEntities, extractRelations, classify } from './extract.ts';
export { retrieve } from './retrieve.ts';
export { mergeSettings, loadSettings } from './store.ts';
