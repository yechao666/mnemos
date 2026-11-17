/**
 * v6 记忆引擎唯一公开入口。
 *
 * - createMemoryService(db, options?) → MemoryService（契约实现）
 * - 其余导出为引擎内部能力（游标、简报压缩、做梦），供 seed、脚本与测试复用。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryService } from '../../../shared/src/types.ts';
import { createMemoryService as createService, type MemoryServiceOptions } from './service.ts';
import type { LlmConfig } from '../env.ts';

/** 创建记忆服务。`options.llm` 仅用于简报润色 / 做梦摘要（可缺省）。 */
export function createMemoryService(db: DatabaseSync, options: MemoryServiceOptions = {}): MemoryService {
  return createService(db, options);
}

export type { MemoryServiceOptions } from './service.ts';
export { EngineError, engineErrors } from './errors.ts';
export { encodeCursor, decodeCursor, normalizeLimit } from './cursor.ts';
export { condenseMemories } from './brief.ts';
export { dreamStatus, runDream, resetDreamLocks } from './dream.ts';
export { startDreamScheduler } from './dream-scheduler.ts';
export { reconcileCounts } from './partition.ts';
export { ftsQuery } from './rows.ts';
export { llmText } from './llm.ts';
export type { LlmConfig };
