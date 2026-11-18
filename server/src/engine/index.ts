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
/* --- v6.1 P0 --- */
export { searchMemories, keywordScore } from './retrieval.ts';
export { memoryHistory, feedbackMemory } from './memories.ts';
export { blobToEmbedding, cosine, embedText, embeddingToBlob, EMBEDDING_DIM, EMBEDDING_MODEL } from './embed.ts';
export {
  claimDueJobs,
  enqueueJob,
  enqueueMemoryJobs,
  enqueuePrivacyJob,
  executeJob,
  extractEntities,
  linkCoOccurringRelations,
  MAX_JOB_ATTEMPTS,
  processJobs,
  processJobsAsync,
  requeueStaleJobs,
  runEmbedJob,
  runPrivacyJob,
  runProfileJob,
  startMemoryJobWorker,
  toMemoryJob,
} from './jobs.ts';
export { writeHistory, listMemoryHistory } from './history.ts';
export { llmText } from './llm.ts';
export {
  buildDeterministicSummary,
  getPersonProfile,
  listPersonFacts,
  normalizeFactInput,
  profileSourceHash,
  refreshPersonProfile,
  removePersonFact,
  syncFactsFromMemories,
  upsertPersonFact,
} from './profile.ts';
export {
  archivePerson,
  deletePerson,
  exportPerson,
  mergePersons,
  resolvePersonRow,
} from './persons.ts';
export { PERSON_EXPORT_MEMORY_LIMIT } from './persons.ts';
/* --- v6.1 P2 --- */
export { buildEntityGraph, listEntities } from './graph.ts';
export {
  attachmentCaptions,
  attachmentCounts,
  insertAttachments,
  listAttachments,
  normalizeAttachments,
  withAttachmentCounts,
} from './attachments.ts';
export { redactPii, applyPiiRedaction } from '../lib/pii.ts';
export { decryptField, encryptField, encryptionKeyFromEnv, isEncryptedField } from '../lib/crypto.ts';
/* --- v6.2 隐私规则域 --- */
export {
  applyPrivacyToMemory,
  applyPrivacyToMemorySync,
  countMemoryPlaceholders,
  countPlaceholderTokens,
  createPrivacyRule,
  deletePrivacyRule,
  extractPromptEntities,
  findPrivacyRule,
  listMemoryPlaceholders,
  listPrivacyRules,
  maskPrivacyValue,
  placeholderTokensOf,
  privacyJobNeeded,
  pruneMemoryPlaceholders,
  rescanPrivacy,
  resolveMemoryPlaceholders,
  scanText,
  scanTextAsync,
  toPrivacyRule,
  updatePrivacyRule,
  validatePlaceholders,
  withPlaceholderCounts,
  writeMemoryPlaceholders,
} from './privacy.ts';
export type { PrivacyApplyResult, PrivacyRuleRow, PrivacyScanOptions, PrivacyRescanResult } from './privacy.ts';
export type { LlmConfig };
