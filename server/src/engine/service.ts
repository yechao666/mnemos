import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  AddMemoryInput,
  BriefInput,
  ContextInput,
  CursorPage,
  Memory,
  MemoryAddResult,
  MemoryBrief,
  MemoryDetail,
  MemoryFeedbackInput,
  MemoryHistoryEntry,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamStatus,
  MemoryListQuery,
  MemorySearchInput,
  MemorySearchResponse,
  MemoryService,
  Partition,
  PartitionInput,
  PartitionStats,
  Person,
  PersonContext,
  PersonExport,
  PersonFact,
  PersonFactInput,
  PersonInput,
  PersonListQuery,
  PersonMergeResult,
  PersonProfile,
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
  feedbackMemory,
  getMemory,
  listMemories,
  memoryHistory,
  removeMemory,
  updateMemory,
} from './memories.ts';
import { buildEntityGraph, listEntities as listEntityRecords } from './graph.ts';
import { searchMemories } from './retrieval.ts';
import {
  getPartition,
  listPartitions,
  partitionStats,
  reconcileCounts,
  updatePartition,
  upsertPartition,
} from './partition.ts';
import {
  archivePerson as archivePersonRecord,
  deletePerson as deletePersonRecord,
  exportPerson as exportPersonRecord,
  getPerson,
  listPersons,
  mergePersons as mergePersonsRecord,
  updatePerson,
  upsertPerson,
} from './persons.ts';
import {
  getPersonProfile,
  listPersonFacts as listPersonFactsRecord,
  refreshPersonProfile as refreshPersonProfileRecord,
  removePersonFact as removePersonFactRecord,
  upsertPersonFact as upsertPersonFactRecord,
} from './profile.ts';

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
      // P2：consent 变更单独审计（合规追溯）。
      if (input.consent !== undefined) {
        audit(db, {
          orgId: orgOfPartition(db, partitionId),
          partitionId,
          actor,
          action: 'person.consent',
          resourceType: 'person',
          resourceId: person.id,
          detail: { consent: input.consent },
        });
      }
      return person;
    },
    reconcileCounts(partitionId: string): ReconcileResult {
      return reconcileCounts(db, partitionId);
    },

    /* --- v6.1 P1：画像 / 生命周期 --- */
    personProfile(partitionId: string, personRef: string): PersonProfile {
      return getPersonProfile(db, partitionId, personRef);
    },
    async refreshPersonProfile(
      partitionId: string,
      personRef: string,
      options?: { force?: boolean },
    ): Promise<PersonProfile> {
      return refreshPersonProfileRecord(db, llm, partitionId, personRef, options);
    },
    listPersonFacts(partitionId: string, personRef: string): PersonFact[] {
      return listPersonFactsRecord(db, partitionId, personRef);
    },
    upsertPersonFact(partitionId: string, personRef: string, input: PersonFactInput, actor: Actor): PersonFact {
      return upsertPersonFactRecord(db, partitionId, personRef, input, actor);
    },
    removePersonFact(partitionId: string, personRef: string, factId: string, actor: Actor): void {
      removePersonFactRecord(db, partitionId, personRef, factId, actor);
    },
    mergePersons(partitionId: string, personRef: string, targetRef: string, actor: Actor): PersonMergeResult {
      const result = mergePersonsRecord(db, partitionId, personRef, targetRef, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'person.merge',
        resourceType: 'person',
        resourceId: result.person.id,
        detail: {
          mergedFrom: result.mergedFrom.id,
          mergedFromExternalId: result.mergedFrom.externalId,
          movedMemories: result.movedMemories,
          movedFacts: result.movedFacts,
        },
      });
      return result;
    },
    archivePerson(partitionId: string, personRef: string, actor: Actor): Person {
      const person = archivePersonRecord(db, partitionId, personRef, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'person.archive',
        resourceType: 'person',
        resourceId: person.id,
        detail: { externalId: person.externalId },
      });
      return person;
    },
    deletePerson(partitionId: string, personRef: string, input: { hard?: boolean }, actor: Actor): void {
      const hard = input.hard === true;
      const person = getPerson(db, partitionId, personRef);
      deletePersonRecord(db, partitionId, personRef, { hard }, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: hard ? 'person.delete.hard' : 'person.delete',
        resourceType: 'person',
        resourceId: person?.id ?? personRef,
        detail: { hard, externalId: person?.externalId },
      });
    },
    exportPerson(partitionId: string, personRef: string): PersonExport {
      const exported = exportPersonRecord(db, partitionId, personRef);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor: { type: 'system', id: 'export', label: 'export' },
        action: 'person.export',
        resourceType: 'person',
        resourceId: exported.person.id,
        detail: {
          memories: exported.memories.length,
          facts: exported.facts.length,
          truncated: exported.truncated === true,
        },
      });
      return exported;
    },

    /* --- 记忆 --- */
    addMemory(input: AddMemoryInput): Memory {
      return addMemory(db, input).memory;
    },
    addMemoryResult(input: AddMemoryInput): MemoryAddResult {
      const result = addMemory(db, input);
      if (result.piiRedacted) {
        audit(db, {
          orgId: orgOfPartition(db, input.partitionId),
          partitionId: input.partitionId,
          actor: input.actor,
          action: 'memory.pii_redacted',
          resourceType: 'memory',
          resourceId: result.memory.id,
          detail: { piiRedaction: 'basic', event: result.event },
        });
      }
      audit(db, {
        orgId: orgOfPartition(db, input.partitionId),
        partitionId: input.partitionId,
        actor: input.actor,
        action: result.event === 'ADD' ? 'memory.add' : `memory.${result.event.toLowerCase()}`,
        resourceType: 'memory',
        resourceId: result.memory.id,
        detail: {
          event: result.event,
          personId: result.memory.personId,
          scope: result.memory.scope,
          category: result.memory.category,
          supersededId: result.supersededId,
        },
      });
      return result;
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
      // P2：内容更新触发脱敏时单独审计。
      if (input.content !== undefined && memory.metadata.piiRedacted === true) {
        audit(db, {
          orgId: orgOfPartition(db, partitionId),
          partitionId,
          actor,
          action: 'memory.pii_redacted',
          resourceType: 'memory',
          resourceId: memory.id,
          detail: { piiRedaction: 'basic', event: 'UPDATE' },
        });
      }
      return memory;
    },
    removeMemory(partitionId: string, id: string, actor: Actor): void {
      removeMemory(db, partitionId, id, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'memory.delete',
        resourceType: 'memory',
        resourceId: id,
      });
    },

    /* --- v6.1：检索 / 历史 / 反馈 --- */
    searchMemories(input: MemorySearchInput): MemorySearchResponse {
      return searchMemories(db, input);
    },
    memoryHistory(partitionId: string, id: string): MemoryHistoryEntry[] {
      return memoryHistory(db, partitionId, id);
    },
    feedback(partitionId: string, id: string, input: MemoryFeedbackInput, actor: Actor): Memory {
      const memory = feedbackMemory(db, partitionId, id, input, actor);
      audit(db, {
        orgId: orgOfPartition(db, partitionId),
        partitionId,
        actor,
        action: 'memory.feedback',
        resourceType: 'memory',
        resourceId: id,
        detail: { helpful: input.helpful, confidence: memory.confidence, query: input.query },
      });
      return memory;
    },

    /* --- v6.1 P2：实体 / 关系图 --- */
    entityGraph(query) {
      return buildEntityGraph(db, query);
    },
    listEntities(query) {
      return listEntityRecords(db, query);
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
