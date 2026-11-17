import type { DatabaseSync } from 'node:sqlite';
import { CATEGORY_LABEL } from '../../../shared/src/constants.ts';
import type { BriefInput, Memory, MemoryBrief, MemoryBriefItem } from '../../../shared/src/types.ts';
import { sha256 } from '../lib/ids.ts';
import { engineErrors } from './errors.ts';
import { llmText } from './llm.ts';
import { briefSourceMemories } from './memories.ts';
import { findPartitionById } from './partition.ts';
import { findPersonRow } from './persons.ts';
import { parseSettings, toBrief, type BriefRow } from './rows.ts';
import type { LlmConfig } from '../env.ts';

const CONDENSE_MODEL = 'mnemos-condense';
const MAX_ITEM_CHARS = 240;

function cleanText(value: string, max = MAX_ITEM_CHARS): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 确定性压缩：按「分类 + 内容」逐行输出，按 maxChars 截断。 */
export function condenseMemories(
  memories: Memory[],
  maxChars: number,
  personLevel: boolean,
): { text: string; count: number; items: MemoryBriefItem[] } {
  const lines: string[] = [];
  const items: MemoryBriefItem[] = [];
  let used = 0;
  for (const memory of memories) {
    const label = CATEGORY_LABEL[memory.category] ?? memory.category;
    const author =
      personLevel && memory.scope === 'partition' && memory.personExternalId
        ? `（${memory.personExternalId}）`
        : '';
    const line = `- [${label}] ${cleanText(memory.content)}${author}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    items.push({
      id: memory.id,
      content: memory.content,
      category: memory.category,
      importance: memory.importance,
      scope: memory.scope,
      updatedAt: memory.updatedAt,
      personId: memory.personId,
      personExternalId: memory.personExternalId,
    });
  }
  return { text: lines.join('\n'), count: lines.length, items };
}

async function polishWithLlm(
  llm: LlmConfig | null,
  memories: Memory[],
  maxChars: number,
): Promise<{ text: string; model: string } | null> {
  if (!llm) return null;
  const source = memories
    .slice(0, 60)
    .map((memory) => `- [${CATEGORY_LABEL[memory.category] ?? memory.category}] ${cleanText(memory.content, 300)}`)
    .join('\n');
  if (!source) return null;
  const text = await llmText(llm, {
    system:
      '你是记忆压缩器。把用户提供的记忆条目压缩成可直接注入系统提示词的要点列表：' +
      '保留事实、偏好、约束、决策与待办；每条一行，以 "- " 开头；不要编造，不要解释。',
    prompt: source,
    maxChars,
    timeoutMs: 20_000,
  });
  if (!text) return null;
  return { text: text.slice(0, maxChars), model: llm.model };
}

/**
 * 记忆简报：人级（本人记忆 + 相关共享）或分区级（scope=partition）。
 * 结果按 source_hash 缓存；force 或来源变化时重新生成。
 */
export async function generateBrief(
  db: DatabaseSync,
  llm: LlmConfig | null,
  input: BriefInput,
): Promise<MemoryBrief> {
  const partition = findPartitionById(db, input.partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  const settings = parseSettings(partition.settings);

  const personId = input.personId;
  if (personId) {
    const person = findPersonRow(db, input.partitionId, personId);
    if (!person) throw engineErrors.notFound('人不存在');
  }

  const maxChars = Math.min(5000, Math.max(100, Math.trunc(input.maxChars ?? settings.briefMaxChars)));
  const scopeKey = personId ? `person:${personId}` : 'partition';
  const sources = briefSourceMemories(db, input.partitionId, personId, 100);
  const sourceHash = sha256(
    `${sources.map((memory) => `${memory.id}:${memory.updatedAt}`).join('|')}|${maxChars}|v6|${llm?.model ?? CONDENSE_MODEL}`,
  );

  const cached = db
    .prepare('SELECT * FROM memory_briefs WHERE partition_id = ? AND scope_key = ?')
    .get(input.partitionId, scopeKey) as unknown as BriefRow | undefined;

  if (cached && cached.source_hash === sourceHash && !input.force) {
    const condensed = condenseMemories(sources, cached.max_chars, Boolean(personId));
    return toBrief(cached, condensed.items, condensed.count, true);
  }

  const deterministic = condenseMemories(sources, maxChars, Boolean(personId));
  let text = deterministic.text;
  let model = CONDENSE_MODEL;
  if (input.allowLlm) {
    const polished = await polishWithLlm(llm, sources, maxChars);
    if (polished) {
      text = polished.text;
      model = polished.model;
    }
  }

  const row: BriefRow = {
    partition_id: input.partitionId,
    scope_key: scopeKey,
    person_id: personId ?? null,
    text,
    max_chars: maxChars,
    model,
    source_hash: sourceHash,
    generated_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO memory_briefs
       (partition_id, scope_key, person_id, text, max_chars, model, source_hash, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(partition_id, scope_key) DO UPDATE SET
       person_id = excluded.person_id,
       text = excluded.text,
       max_chars = excluded.max_chars,
       model = excluded.model,
       source_hash = excluded.source_hash,
       generated_at = excluded.generated_at`,
  ).run(
    row.partition_id,
    row.scope_key,
    row.person_id,
    row.text,
    row.max_chars,
    row.model,
    row.source_hash,
    row.generated_at,
  );

  return toBrief(row, deterministic.items, deterministic.count, false);
}
