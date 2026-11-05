import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../../../shared/src/types.ts';
import { newId, nowIso } from './ids.ts';

export interface AuditInput {
  orgId?: string;
  projectId?: string;
  actor: Actor;
  action: string;
  resourceType: string;
  resourceId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  org_id: string | null;
  project_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export function writeAudit(db: DatabaseSync, input: AuditInput): string {
  const id = newId('aud');
  db.prepare(
    `INSERT INTO audit_logs
      (id, org_id, project_id, actor_type, actor_id, actor_label, action,
       resource_type, resource_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.orgId ?? null,
    input.projectId ?? null,
    input.actor.type,
    input.actor.id,
    input.actor.label,
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    JSON.stringify(input.detail ?? {}),
    input.actor.ip ?? null,
    input.actor.userAgent ?? null,
    nowIso(),
  );
  return id;
}
