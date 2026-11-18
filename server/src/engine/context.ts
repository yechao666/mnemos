import type { DatabaseSync } from 'node:sqlite';
import type { ContextInput, Memory, Person, PersonContext } from '../../../shared/src/types.ts';
import { estimateTokens } from '../lib/usage.ts';
import { generateBrief } from './brief.ts';
import type { LlmLike } from './llm.ts';
import { engineErrors } from './errors.ts';
import { personMemories, sharedMemories } from './memories.ts';
import { findPartitionById } from './partition.ts';
import { resolveMemoryPlaceholders } from './privacy.ts';
import { resolvePerson } from './persons.ts';

function trimToBudget(lines: string[], budgetChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budgetChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

const DEFAULT_BUDGET_TOKENS = 2_000;

/**
 * 人的上下文：资料 + 人级简报 + 相关记忆 + 分区共享知识，拼成可直接注入的 prompt。
 * 按 budgetTokens 截断，不调用 LLM（简报复用 generateBrief 的缓存/确定性压缩）。
 */
export async function buildContext(
  db: DatabaseSync,
  llm: LlmLike,
  input: ContextInput,
): Promise<PersonContext> {
  if (!findPartitionById(db, input.partitionId)) throw engineErrors.notFound('分区不存在');
  const person = resolvePerson(db, input.partitionId, input.personId);
  const budgetTokens = Math.min(32_000, Math.max(60, Math.trunc(input.budgetTokens ?? DEFAULT_BUDGET_TOKENS)));
  const budgetChars = Math.max(240, budgetTokens * 4);

  const brief = await generateBrief(db, llm, {
    partitionId: input.partitionId,
    personId: person.id,
    // 上下文热路径只用确定性压缩，避免额外 LLM 往返
    allowLlm: false,
  });

  const query = (input.query ?? '').trim() || undefined;
  // v6.2：上下文注入前把占位符还原为真实值（服务端内部使用，不直接回传数据库明文）。
  const memories = resolveMemoryPlaceholders(
    db,
    input.partitionId,
    personMemories(db, input.partitionId, person.id, query, 20),
  );
  const includePartition = input.includePartition !== false;
  const shared = includePartition
    ? resolveMemoryPlaceholders(db, input.partitionId, sharedMemories(db, input.partitionId, query, 10))
    : [];

  const header = [
    '## 人物资料',
    `- external_id: ${person.externalId}`,
    `- 类型: ${person.type}`,
    `- 显示名: ${person.displayName || person.externalId}`,
    `- 记忆数: ${person.memoryCount}（共享 ${person.sharedMemoryCount}）`,
    `- 最近活跃: ${person.lastSeenAt}`,
  ];

  const briefSection = brief.text ? ['', '## 记忆简报', brief.text] : [];
  const memoryLines = memories.map((memory) => `- [${memory.category}] ${memory.content.replace(/\s+/g, ' ').slice(0, 400)}`);
  const sharedLines = shared.map(
    (memory) => `- [${memory.category}] ${memory.content.replace(/\s+/g, ' ').slice(0, 400)}${memory.personExternalId ? `（${memory.personExternalId}）` : ''}`,
  );

  const baseLength = header.join('\n').length + briefSection.join('\n').length;
  const remaining = Math.max(0, budgetChars - baseLength);
  // 共享知识优先（团队约定/事实），剩余预算给本人相关记忆。
  const keptShared = trimToBudget(sharedLines, Math.floor(remaining * 0.4));
  const keptMemories = trimToBudget(memoryLines, remaining - keptShared.join('\n').length);

  const parts = [...header, ...briefSection];
  if (keptMemories.length > 0) parts.push('', '## 相关记忆', ...keptMemories);
  if (keptShared.length > 0) parts.push('', '## 分区共享知识', ...keptShared);
  const prompt = parts.join('\n').trim();

  const citations = [
    ...memories.slice(0, keptMemories.length).map((memory) => memory.id),
    ...shared.slice(0, keptShared.length).map((memory) => memory.id),
  ];

  return {
    person,
    brief,
    memories: memories.slice(0, keptMemories.length),
    shared: shared.slice(0, keptShared.length),
    prompt,
    tokenEstimate: estimateTokens(prompt),
    citations,
    builtAt: new Date().toISOString(),
  };
}
