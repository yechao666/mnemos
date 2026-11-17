import { z } from 'zod';
import type { ApiKey, Project } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newApiKeySecret, newId, nowIso } from '../../lib/ids.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { publishLive } from '../live.ts';
import { toApiKey, type ApiKeyRow, type ProjectRow } from '../mappers.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { HttpError, errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { apiKeyCreateSchema, apiKeyRotateSchema } from '../schemas.ts';

function loadKey(rc: RequestContext, projectId: string, keyId: string): ApiKeyRow | null {
  // 只允许通过分区端点管理 project key；org key 即使锚定在该分区也必须走 /api/org/keys。
  const row = rc.app.db
    .prepare("SELECT * FROM api_keys WHERE id = ? AND project_id = ? AND kind = 'project'")
    .get(keyId, projectId) as unknown as ApiKeyRow | undefined;
  return row ?? null;
}

function normalizeExpiry(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/** org key 创建：在项目 key 参数基础上可选锚点分区（缺省取组织最早创建的分区）。 */
const orgApiKeyCreateSchema = apiKeyCreateSchema.extend({
  partitionId: z.string().trim().max(64).optional(),
});

/** org key 管理仅组织所有者可操作。 */
function requireOrgOwner(rc: RequestContext) {
  const auth = requireConsoleAuth(rc);
  if (auth.user.role !== 'owner') throw errors.forbidden('组织级 API Key 仅组织所有者可管理');
  return auth;
}

/** org key 必须绑定一个锚点分区（schema: api_keys.project_id NOT NULL），优先使用显式 partitionId。 */
function orgAnchorProject(rc: RequestContext, orgId: string, preferredId?: string): ProjectRow {
  if (preferredId) {
    const row = rc.app.db
      .prepare('SELECT * FROM projects WHERE id = ? AND org_id = ?')
      .get(preferredId, orgId) as unknown as ProjectRow | undefined;
    if (!row) throw errors.notFound('锚点分区不存在或不属于当前组织');
    return row;
  }
  const row = rc.app.db
    .prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at ASC, id ASC LIMIT 1')
    .get(orgId) as unknown as ProjectRow | undefined;
  if (!row) {
    throw errors.conflict('组织下还没有分区：请先创建至少一个分区（项目 key 可自助创建），再创建 org key');
  }
  return row;
}

function loadOrgKey(rc: RequestContext, orgId: string, keyId: string): ApiKeyRow | null {
  const row = rc.app.db
    .prepare("SELECT * FROM api_keys WHERE id = ? AND org_id = ? AND kind = 'org'")
    .get(keyId, orgId) as unknown as ApiKeyRow | undefined;
  return row ?? null;
}

export function registerKeyRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/keys',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      const rows = rc.app.db
        .prepare(
          `SELECT * FROM api_keys WHERE project_id = ? AND kind = 'project'
            ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
        )
        .all(project.id) as unknown as ApiKeyRow[];
      rc.json(rows.map(toApiKey) satisfies ApiKey[]);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/keys',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(apiKeyCreateSchema);
      const scopes = [...new Set(input.scopes)];
      const allowedIps = [...new Set(input.allowedIps ?? [])];
      const expiresAt = input.expiresAt ? normalizeExpiry(input.expiresAt) : null;
      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      const createdAt = nowIso();

      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, project_id, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          project.id,
          input.name,
          prefix,
          hash,
          JSON.stringify(scopes),
          auth.user.id,
          createdAt,
          input.rateLimitPerMin ?? 600,
          expiresAt,
          JSON.stringify(allowedIps),
        );

      const row = loadKey(rc, project.id, id);
      if (!row) throw errors.internal('API Key 写入失败');
      const key = toApiKey(row);

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'key.create',
        resourceType: 'api_key',
        resourceId: key.id,
        detail: {
          name: key.name,
          prefix: key.prefix,
          scopes,
          rateLimitPerMin: key.rateLimitPerMin,
          expiresAt: key.expiresAt ?? null,
          allowedIps: key.allowedIps,
        },
      });
      publishLive(rc.app, {
        type: 'key.created',
        projectId: project.id,
        projectName: project.name,
        actor: auth.user.name,
        summary: `创建 API 密钥「${key.name}」`,
        meta: { prefix: key.prefix, scopes },
      });

      // 明文密钥仅在此响应中出现一次，之后不可再取回。
      rc.json({ ...key, secret }, 201);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/keys/:keyId/rotate',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const keyId = rc.params.keyId ?? '';
      const input = await rc.body(apiKeyRotateSchema);
      const graceHours = input.graceHours ?? 0;

      const old = loadKey(rc, project.id, keyId);
      if (!old || old.revoked_at) {
        throw new HttpError(409, 'key_revoked', '该 API Key 不存在或已被吊销，无法轮换');
      }

      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      const now = nowIso();
      const name = `${old.name} 轮换`.slice(0, 80);

      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, project_id, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips, rotated_from, rotated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          project.id,
          name,
          prefix,
          hash,
          old.scopes,
          auth.user.id,
          now,
          old.rate_limit_per_min,
          old.expires_at ?? null,
          old.allowed_ips ?? '[]',
          old.id,
          now,
        );

      if (graceHours === 0) {
        rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now, old.id);
      } else {
        const graceExpiry = new Date(Date.now() + graceHours * 3_600_000).toISOString();
        rc.app.db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(graceExpiry, old.id);
      }

      const row = loadKey(rc, project.id, id);
      if (!row) throw errors.internal('API Key 轮换写入失败');
      const key = toApiKey(row);

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'key.rotate',
        resourceType: 'api_key',
        resourceId: key.id,
        detail: {
          rotatedFrom: old.id,
          previousName: old.name,
          previousPrefix: old.prefix,
          name: key.name,
          prefix: key.prefix,
          graceHours,
          revokedImmediately: graceHours === 0,
          expiresAt: key.expiresAt ?? null,
          allowedIps: key.allowedIps,
        },
      });
      publishLive(rc.app, {
        type: 'key.created',
        projectId: project.id,
        projectName: project.name,
        actor: auth.user.name,
        summary: `轮换 API 密钥「${old.name}」`,
        meta: { prefix: key.prefix, rotatedFrom: old.id, graceHours },
      });

      rc.json({ ...key, secret }, 201);
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/projects/:id/keys/:keyId',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const keyId = rc.params.keyId ?? '';
      const row = loadKey(rc, project.id, keyId);
      if (!row) throw errors.notFound('API Key 不存在');
      if (!row.revoked_at) {
        rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), keyId);
        writeAudit(rc.app.db, {
          orgId: project.orgId,
          projectId: project.id,
          actor: actorForUser(rc, auth.user),
          action: 'key.revoke',
          resourceType: 'api_key',
          resourceId: keyId,
          detail: { name: row.name, prefix: row.prefix },
        });
        publishLive(rc.app, {
          type: 'key.revoked',
          projectId: project.id,
          projectName: project.name,
          actor: auth.user.name || auth.user.email,
          summary: `吊销 API 密钥「${row.name}」`,
          meta: { prefix: row.prefix },
        });
      }
      rc.json({ ok: true });
    },
  });

  /* ------------------------------------------------------------------ */
  /* 组织级 API Key（kind=org）：可访问/创建本组织任意分区               */
  /* 仅组织 owner 可创建/查看/吊销；锚点分区只用于审计与用量兜底。        */
  /* ------------------------------------------------------------------ */

  router.add({
    method: 'GET',
    path: '/api/org/keys',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOrgOwner(rc);
      const rows = rc.app.db
        .prepare(
          `SELECT * FROM api_keys
            WHERE org_id = ? AND kind = 'org'
            ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
        )
        .all(auth.org.id) as unknown as ApiKeyRow[];
      rc.json(rows.map(toApiKey) satisfies ApiKey[]);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/keys',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOrgOwner(rc);
      const input = await rc.body(orgApiKeyCreateSchema);
      const anchor = orgAnchorProject(rc, auth.org.id, input.partitionId);
      const scopes = [...new Set(input.scopes)];
      const allowedIps = [...new Set(input.allowedIps ?? [])];
      const expiresAt = input.expiresAt ? normalizeExpiry(input.expiresAt) : null;
      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      const createdAt = nowIso();

      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, project_id, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips, kind, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'org', ?)`,
        )
        .run(
          id,
          anchor.id,
          input.name,
          prefix,
          hash,
          JSON.stringify(scopes),
          auth.user.id,
          createdAt,
          input.rateLimitPerMin ?? 600,
          expiresAt,
          JSON.stringify(allowedIps),
          auth.org.id,
        );

      const row = rc.app.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as ApiKeyRow | undefined;
      if (!row) throw errors.internal('org API Key 写入失败');
      const key = toApiKey(row);

      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        projectId: anchor.id,
        actor: actorForUser(rc, auth.user),
        action: 'key.create',
        resourceType: 'api_key',
        resourceId: key.id,
        detail: {
          kind: 'org',
          name: key.name,
          prefix: key.prefix,
          scopes,
          anchorPartitionId: anchor.id,
          rateLimitPerMin: key.rateLimitPerMin,
          expiresAt: key.expiresAt ?? null,
          allowedIps: key.allowedIps,
        },
      });
      publishLive(rc.app, {
        type: 'key.created',
        projectId: anchor.id,
        projectName: anchor.name,
        actor: auth.user.name || auth.user.email,
        summary: `创建组织级 API 密钥「${key.name}」`,
        meta: { prefix: key.prefix, scopes, kind: 'org' },
      });

      // 明文密钥仅在此响应中出现一次，之后不可再取回。
      rc.json({ ...key, secret }, 201);
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/org/keys/:keyId',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOrgOwner(rc);
      const keyId = rc.params.keyId ?? '';
      const row = loadOrgKey(rc, auth.org.id, keyId);
      if (!row) throw errors.notFound('组织级 API Key 不存在');
      if (!row.revoked_at) {
        rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), keyId);
        writeAudit(rc.app.db, {
          orgId: auth.org.id,
          projectId: row.project_id,
          actor: actorForUser(rc, auth.user),
          action: 'key.revoke',
          resourceType: 'api_key',
          resourceId: keyId,
          detail: { kind: 'org', name: row.name, prefix: row.prefix },
        });
        publishLive(rc.app, {
          type: 'key.revoked',
          projectId: row.project_id,
          actor: auth.user.name || auth.user.email,
          summary: `吊销组织级 API 密钥「${row.name}」`,
          meta: { prefix: row.prefix, kind: 'org' },
        });
      }
      rc.json({ ok: true });
    },
  });
}
