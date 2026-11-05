import type { Actor, Project, ProjectExport } from '../../../../shared/src/types.ts';
import { mapTask, type TaskRow } from '../../engine/tasks.ts';
import { writeAudit } from '../../lib/audit.ts';
import { nowIso } from '../../lib/ids.ts';
import { actorForApiKey, actorForUser, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { toMemory, type MemoryRow } from '../mappers.ts';
import { requireConsoleAuth, requireKeyAuth } from '../middleware/auth.ts';
import { HttpError, errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { exportQuerySchema, importMemorySchema, importRequestSchema } from '../schemas.ts';

/**
 * 项目数据导出 / 导入。
 *
 * 导出为 `ProjectExport`（active + archived，不含 deleted）；单项目上限 50,000 条记忆。
 * 导入逐条走 `engine.add({infer:false, mode:'consolidate', source:'import'})`：
 * 重复内容按 consolidate 语义合并并计入 skipped；单次最多 1000 条。
 */

export const MAX_EXPORT_MEMORIES = 50_000;
export const MAX_IMPORT_ITEMS = 1_000;
const MAX_IMPORT_ERRORS = 200;

export interface ImportErrorItem {
  index: number;
  message: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: ImportErrorItem[];
}

function loadExportMemories(rc: RequestContext, projectId: string) {
  const rows = rc.app.db
    .prepare(
      `SELECT * FROM memories
        WHERE project_id = ? AND status <> 'deleted'
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(projectId, MAX_EXPORT_MEMORIES + 1) as unknown as MemoryRow[];
  if (rows.length > MAX_EXPORT_MEMORIES) {
    throw new HttpError(
      413,
      'export_too_large',
      `该项目的记忆超过 ${MAX_EXPORT_MEMORIES} 条，请分批导出（例如按任务或时间范围）`,
    );
  }
  return rows.map(toMemory);
}

function loadExportTasks(rc: RequestContext, projectId: string) {
  const rows = rc.app.db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM memories m
          WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.status = 'active') AS memory_count,
        (SELECT COUNT(DISTINCT m.agent_id) FROM memories m
          WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.status = 'active' AND m.agent_id IS NOT NULL) AS agent_count,
        (SELECT a.name FROM agents a WHERE a.project_id = t.project_id AND a.id = t.owner_agent_id) AS owner_name
       FROM tasks t
      WHERE t.project_id = ?
      ORDER BY t.started_at ASC, t.id ASC`,
    )
    .all(projectId) as unknown as TaskRow[];
  return rows.map(mapTask);
}

async function buildProjectExport(rc: RequestContext, project: Project): Promise<ProjectExport> {
  const memories = loadExportMemories(rc, project.id);
  const tasks = loadExportTasks(rc, project.id);
  const agents = await engineCall(rc, () => rc.app.engine.agents(project.id));
  return {
    format: 'mnemos-export/v1',
    exportedAt: nowIso(),
    project: { id: project.id, slug: project.slug, name: project.name },
    agents,
    tasks,
    memories,
  };
}

async function runImport(rc: RequestContext, project: Project, actor: Actor): Promise<ImportResult> {
  const parsed = importRequestSchema.safeParse(await rc.readBody());
  if (!parsed.success) {
    throw errors.validation(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const items = parsed.data.memories;
  if (items.length === 0) throw errors.validation([{ path: 'memories', message: '至少提供一条待导入记忆' }]);
  if (items.length > MAX_IMPORT_ITEMS) {
    throw errors.validation([
      { path: 'memories', message: `单次最多导入 ${MAX_IMPORT_ITEMS} 条记忆，当前 ${items.length} 条` },
    ]);
  }

  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] };

  for (let index = 0; index < items.length; index += 1) {
    const record = importMemorySchema.safeParse(items[index]);
    if (!record.success) {
      result.failed += 1;
      if (result.errors.length < MAX_IMPORT_ERRORS) {
        result.errors.push({ index, message: record.error.issues[0]?.message ?? '记录格式不正确' });
      }
      continue;
    }

    const item = record.data;
    const content = (item.content ?? item.text ?? '').trim();
    if (!content) {
      result.failed += 1;
      if (result.errors.length < MAX_IMPORT_ERRORS) {
        result.errors.push({ index, message: '缺少 content 字段' });
      }
      continue;
    }

    try {
      const added = await engineCall(rc, () =>
        rc.app.engine.add({
          projectId: project.id,
          text: content,
          userId: item.userId,
          agentId: item.agentId,
          runId: item.runId,
          appId: item.appId,
          taskId: item.taskId,
          visibility: item.visibility,
          metadata: item.metadata,
          tags: item.tags,
          infer: false,
          mode: 'consolidate',
          source: 'import',
          actor,
        }),
      );
      result.imported += added.results.length;
      result.skipped += added.merged;
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < MAX_IMPORT_ERRORS) {
        result.errors.push({ index, message: error instanceof Error ? error.message : '写入记忆失败' });
      }
    }
  }

  writeAudit(rc.app.db, {
    orgId: project.orgId,
    projectId: project.id,
    actor,
    action: 'memory.import',
    resourceType: 'memory',
    resourceId: project.id,
    detail: {
      requested: items.length,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      format: parsed.data.format ?? null,
    },
  });

  return result;
}

export function registerExportRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/export',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const document = await buildProjectExport(rc, project);
      rc.json(document);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/import',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    operation: 'add',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const result = await runImport(rc, project, actorForUser(rc, auth.user));
      rc.noteUsage(result.imported);
      rc.json(result);
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/export',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'list',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      rc.query(exportQuerySchema); // 目前仅支持 format=json，非法格式返回 400
      const document = await buildProjectExport(rc, project);
      rc.noteUsage(document.memories.length);
      rc.json(document);
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/import',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'add',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const result = await runImport(rc, project, actorForApiKey(rc, key, project));
      rc.noteUsage(result.imported);
      rc.json(result);
    },
  });
}
