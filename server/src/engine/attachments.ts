import type { DatabaseSync } from 'node:sqlite';
import {
  ATTACHMENT_KINDS,
  MAX_ATTACHMENTS_PER_MEMORY,
  MAX_ATTACHMENT_CAPTION_LENGTH,
  MAX_ATTACHMENT_URL_LENGTH,
} from '../../../shared/src/constants.ts';
import type { AttachmentKind, MemoryAttachment, MemoryAttachmentInput } from '../../../shared/src/types.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { engineErrors } from './errors.ts';

/**
 * v6.1 P2 多模态附件：只存 URL / 元数据 / caption（媒体本体由调用方托管）。
 *
 * - 写入：`memory_attachments`，每记忆 ≤10 条、url ≤2000；配置 MNEMOS_ENCRYPTION_KEY 时
 *   url 落库前 AES-256-GCM 加密（格式 v1:iv:tag:cipher），读取时解密。
 * - 读取：详情返回附件数组；批量列表只按页统计 attachmentCount（避免 N+1 / 体积膨胀）。
 * - 检索：caption 作为轻量文本参与候选与 keyword 信号（见 retrieval.ts）。
 */

export const ATTACHMENT_KIND_SET = new Set<string>(ATTACHMENT_KINDS);

export interface AttachmentRow {
  id: string;
  partition_id: string;
  memory_id: string;
  kind: string;
  url: string;
  mime: string | null;
  size: number | null;
  caption: string | null;
  created_at: string;
}

/** 校验并规范化写入附件（未知字段忽略；kind/url 必填）。 */
export function normalizeAttachments(raw: unknown): MemoryAttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw engineErrors.validation('attachments 必须是数组');
  if (raw.length > MAX_ATTACHMENTS_PER_MEMORY) {
    throw engineErrors.validation(`attachments 最多 ${MAX_ATTACHMENTS_PER_MEMORY} 个`);
  }
  const result: MemoryAttachmentInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw engineErrors.validation('attachments 元素必须是对象');
    const input = item as Record<string, unknown>;
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    if (!ATTACHMENT_KIND_SET.has(kind)) {
      throw engineErrors.validation(`附件 kind 不合法（支持 ${ATTACHMENT_KINDS.join('/')}）`);
    }
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) throw engineErrors.validation('附件 url 不能为空');
    if (url.length > MAX_ATTACHMENT_URL_LENGTH) {
      throw engineErrors.validation(`附件 url 最长 ${MAX_ATTACHMENT_URL_LENGTH} 字符`);
    }
    if (url.startsWith('v1:')) {
      // 防止调用方把内部密文格式当 URL 写入，导致读取时被误解密。
      throw engineErrors.validation('附件 url 不能使用 v1: 前缀（保留给加密存储）');
    }
    const attachment: MemoryAttachmentInput = { kind: kind as AttachmentKind, url };
    if (input.mime !== undefined) {
      const mime = String(input.mime).trim();
      if (mime.length > 200) throw engineErrors.validation('附件 mime 最长 200 字符');
      if (mime) attachment.mime = mime;
    }
    if (input.size !== undefined) {
      const size = Number(input.size);
      if (!Number.isFinite(size) || size < 0) throw engineErrors.validation('附件 size 必须是非负数字');
      attachment.size = Math.trunc(size);
    }
    if (input.caption !== undefined) {
      const caption = String(input.caption).trim();
      if (caption.length > MAX_ATTACHMENT_CAPTION_LENGTH) {
        throw engineErrors.validation(`附件 caption 最长 ${MAX_ATTACHMENT_CAPTION_LENGTH} 字符`);
      }
      if (caption) attachment.caption = caption;
    }
    result.push(attachment);
  }
  return result;
}

/** 写入附件（调用方负责放在写入事务内）；返回写入条数。 */
export function insertAttachments(
  db: DatabaseSync,
  partitionId: string,
  memoryId: string,
  attachments: MemoryAttachmentInput[],
): number {
  if (attachments.length === 0) return 0;
  const at = nowIso();
  const stmt = db.prepare(
    `INSERT INTO memory_attachments (id, partition_id, memory_id, kind, url, mime, size, caption, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const attachment of attachments) {
    stmt.run(
      newId('att'),
      partitionId,
      memoryId,
      attachment.kind,
      encryptField(attachment.url),
      attachment.mime ?? null,
      attachment.size ?? null,
      attachment.caption ?? null,
      at,
    );
  }
  return attachments.length;
}

function toAttachment(row: AttachmentRow): MemoryAttachment {
  const attachment: MemoryAttachment = {
    id: row.id,
    memoryId: row.memory_id,
    kind: row.kind as AttachmentKind,
    url: decryptField(row.url),
    createdAt: row.created_at,
  };
  if (row.mime) attachment.mime = row.mime;
  if (row.size !== null) attachment.size = row.size;
  if (row.caption) attachment.caption = row.caption;
  return attachment;
}

/** 记忆详情：返回解密后的附件明细（按创建时间/插入顺序）。 */
export function listAttachments(db: DatabaseSync, memoryId: string): MemoryAttachment[] {
  const rows = db
    .prepare('SELECT * FROM memory_attachments WHERE memory_id = ? ORDER BY rowid ASC')
    .all(memoryId) as unknown as AttachmentRow[];
  return rows.map(toAttachment);
}

/** 批量列表：一次分组查询取回每页记忆的附件数量（避免 N+1）。 */
export function attachmentCounts(db: DatabaseSync, memoryIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (memoryIds.length === 0) return result;
  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT memory_id AS memory_id, COUNT(*) AS c
         FROM memory_attachments
        WHERE memory_id IN (${placeholders})
        GROUP BY memory_id`,
    )
    .all(...memoryIds) as unknown as { memory_id: string; c: number }[];
  for (const row of rows) result.set(row.memory_id, row.c);
  return result;
}

/** 给一批 Memory 补 attachmentCount（列表/检索 hit 用）。 */
export function withAttachmentCounts<T extends { id: string; attachmentCount?: number }>(
  db: DatabaseSync,
  memories: T[],
): T[] {
  const counts = attachmentCounts(db, memories.map((memory) => memory.id));
  for (const memory of memories) {
    const count = counts.get(memory.id);
    if (count !== undefined) memory.attachmentCount = count;
  }
  return memories;
}

/** 候选集的附件 caption（检索加权 + matchedOn 标记用）。 */
export function attachmentCaptions(db: DatabaseSync, memoryIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (memoryIds.length === 0) return result;
  const placeholders = memoryIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT memory_id AS memory_id, caption AS caption
         FROM memory_attachments
        WHERE memory_id IN (${placeholders}) AND caption IS NOT NULL AND caption <> ''`,
    )
    .all(...memoryIds) as unknown as { memory_id: string; caption: string }[];
  for (const row of rows) {
    const list = result.get(row.memory_id) ?? [];
    list.push(row.caption);
    result.set(row.memory_id, list);
  }
  return result;
}
