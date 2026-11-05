import { z } from 'zod';
import type { ApiKey, Project } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newApiKeySecret, newId, nowIso } from '../../lib/ids.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { publishLive } from '../live.ts';
import { toApiKey, type ApiKeyRow } from '../mappers.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { HttpError, errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { apiKeyCreateSchema, apiKeyRotateSchema } from '../schemas.ts';

function loadKey(rc: RequestContext, projectId: string, keyId: string): ApiKeyRow | null {
  const row = rc.app.db
    .prepare('SELECT * FROM api_keys WHERE id = ? AND project_id = ?')
    .get(keyId, projectId) as unknown as ApiKeyRow | undefined;
  return row ?? null;
}

function normalizeExpiry(value: string): string {
  return new Date(Date.parse(value)).toISOString();
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
          `SELECT * FROM api_keys WHERE project_id = ?
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
}
