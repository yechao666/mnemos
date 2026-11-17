import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  AddMemoryInput,
  BriefInput,
  ContextInput,
  CursorPage,
  Memory,
  MemoryBrief,
  MemoryDetail,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamStatus,
  MemoryListQuery,
  MemoryService,
  Partition,
  PartitionInput,
  PartitionStats,
  Person,
  PersonContext,
  PersonInput,
  PersonListQuery,
  ReconcileResult,
  UpdateMemoryInput,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { writeAudit } from '../lib/audit.ts';
import { generateBrief } from './brief.ts';
import { buildContext } from './context.ts';
import { dreamStatus, runDream } from './dream.ts';
import {
  addMemory,
  getMemory,
  listMemories,
  removeMemory,
  updateMemory,
} from './memories.ts';
import {
  getPartition,
  listPartitions,
  partitionStats,
  reconcileCounts,
  updatePartition,
  upsertPartition,
} from './partition.ts';
import { getPerson, listPersons, updatePerson, upsertPerson } from './persons.ts';

export interface MemoryServiceOptions {
  llm?: LlmConfig | null;
}

function audit(
  db: DatabaseSync,
  input: {
    actor: Actor;
    action: string;
    resourceType: string;
    resourceId?: string;
    partitionId?: string;
    orgId?: string;
    detail?: Record<string, unknown>;
  },
): void {
  try {
    writeAudit(db, input);
  } catch {
    /* 审计失败不影响主流程 */
  }
}

function orgOfPartition(db: DatabaseSync, partitionId: string): string | undefined {
  const row = db.prepare('SELECT org_id FROM partitions WHERE id = ?').get(partitionId) as unknown as
    | { org_id: string }
    | undefined;
  return row?.org_id;
}

/** 组装 v6 记忆服务。 */
export function createMemoryService(db: DatabaseSync, options: MemoryServiceOptions = {}): MemoryService {
  const llm = options.llm ?? null;

  return {
    /* --- 分区 --- */
    upsertPartition(orgId: string, input: PartitionInput, actor: Actor): Partition {
      const partition = upsertPartition(db, orgId, input, actor);
      audit(db, {
        orgId,
        partitionId: partition.id,
        actor,
        action: 'partition.upsert',
        resourceType: 'partition',
        resourceId: partition.id,
        detail: { slug: partition.slug, name: partition.name },
      });
      return partition;
    },
    listPartitions(orgId: string): Partition[] {
      return listPartitions(db, orgId);
    },
    getPartition(orgId: string, ref: string): Partition | null {
      return getPartition(db, orgId, ref);
    },
    updatePartition(orgId: string, ref: string, input: Partial<PartitionInput>, actor: Actor): Partition {
      const partition = updatePartition(db, orgId, ref, input, actor);
      audit(db, {
        orgId,
        partitionId: partition.id,
        actor,
        action: 'partition.update',
        resourceType: 'partition',
        resourceId: partition.id,
        detail: { ...input },
      });
      return partition;
    },
    partitionStats(partitionId: string): PartitionStats {
      return partitionStats(db, partitionId);
    },

    /* --- 人 --- */
    upsertPerson(partitionId: string, input: PersonInput, actor: Actor): Person {
      const person = upsertPerson(db, partitionId, input, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'person.upsert',
        resourceType: 'person',
        resourceId: person.id,
        detail: { externalId: person.externalId, type: person.type },
      });
      return person;
    },
    listPersons(partitionId: string, query: PersonListQuery): CursorPage<Person> {
      return listPersons(db, partitionId, query);
    },
    getPerson(partitionId: string, ref: string): Person | null {
      return getPerson(db, partitionId, ref);
    },
    updatePerson(partitionId: string, ref: string, input: Partial<PersonInput>, actor: Actor): Person {
      const person = updatePerson(db, partitionId, ref, input, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'person.update',
        resourceType: 'person',
        resourceId: person.id,
        detail: { ...input },
      });
      return person;
    },
    reconcileCounts(partitionId: string): ReconcileResult {
      return reconcileCounts(db, partitionId);
    },

    /* --- 记忆 --- */
    addMemory(input: AddMemoryInput): Memory {
      const memory = addMemory(db, input);
      audit(db, {
        orgId: orgOfPartition(db, input.partitionId),
        partitionId: input.partitionId,
        actor: input.actor,
        action: 'memory.add',
        resourceType: 'memory',
        resourceId: memory.id,
        detail: { personId: memory.personId, scope: memory.scope, category: memory.category },
      });
      return memory;
    },
    listMemories(query: MemoryListQuery): CursorPage<Memory> {
      return listMemories(db, query);
    },
    getMemory(partitionId: string, id: string): MemoryDetail | null {
      return getMemory(db, partitionId, id);
    },
    updateMemory(partitionId: string, id: string, input: UpdateMemoryInput, actor: Actor): Memory {
      const memory = updateMemory(db, partitionId, id, input, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'memory.update',
        resourceType: 'memory',
        resourceId: memory.id,
        detail: { ...input },
      });
      return memory;
    },
    removeMemory(partitionId: string, id: string, actor: Actor): void {
      removeMemory(db, partitionId, id);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'memory.delete',
        resourceType: 'memory',
        resourceId: id,
      });
    },

    /* --- 简报 / 上下文 / 做梦 --- */
    brief(input: BriefInput): Promise<MemoryBrief> {
      return generateBrief(db, llm, input);
    },
    context(input: ContextInput): Promise<PersonContext> {
      return buildContext(db, llm, input);
    },
    dreamStatus(input: { partitionId: string; personId?: string }): MemoryDreamStatus {
      return dreamStatus(db, input.partitionId, input.personId);
    },
    async dream(input: MemoryDreamInput, actor: Actor): Promise<MemoryDreamResult> {
      const result = await runDream(db, llm, input, actor);
      audit(db, {
        orgId: orgOfPartition(db, input.partitionId),
        partitionId: input.partitionId,
        actor,
        action: 'dream.run',
        resourceType: 'dream_run',
        resourceId: result.run?.id,
        detail: {
          personId: input.personId,
          status: result.run?.status,
          inputCount: result.run?.inputCount,
          insightCount: result.run?.insightCount,
        },
      });
      return result;
    },
  };
}
