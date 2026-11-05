import type { DatabaseSync } from 'node:sqlite';
import type { Env } from '../env.ts';
import type { EventBus } from '../lib/bus.ts';
import type { MemoryCategory, MemoryService, ProjectSettings, Role, LiveEvent } from '../../../shared/src/types.ts';
import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/src/constants.ts';
import { hashPassword } from '../lib/password.ts';
import { addDays, newId, nowIso, sha256 } from '../lib/ids.ts';
import { tx } from '../db/index.ts';
import {
  DEMO_KEYS,
  DEMO_PASSWORD,
  DEMO_WEBHOOKS,
  ORG,
  PROJECTS,
  USERS,
  type SeedAgent,
  type SeedFact,
  type SeedTask,
} from './data.ts';

const DAY = 86_400_000;
const BASE = Date.now();

export interface SeedOptions {
  db: DatabaseSync;
  engine: MemoryService;
  bus: EventBus;
  env: Env;
  log?: (line: string) => void;
  force?: boolean;
}

export interface SeedSummary {
  projects: number;
  members: number;
  agents: number;
  tasks: number;
  memories: number;
  usageEvents: number;
  auditEvents: number;
  demoApiKey?: { projectSlug: string; secret: string };
}

/** 确定性伪随机（mulberry32），保证每次 seed 结果一致。 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20261105);

function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function isoDaysAgo(days: number, extraHours = 0): string {
  return new Date(BASE - days * DAY + extraHours * 3_600_000).toISOString();
}

function cnDate(daysAgo: number): string {
  const d = new Date(BASE - daysAgo * DAY);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function projectSettings(partial: Partial<ProjectSettings>): ProjectSettings {
  return {
    ...DEFAULT_PROJECT_SETTINGS,
    ...partial,
    weights: { ...DEFAULT_PROJECT_SETTINGS.weights, ...(partial.weights ?? {}) },
  };
}

function wipe(db: DatabaseSync): void {
  const tables = [
    'sessions',
    'idempotency_keys',
    'webhook_deliveries',
    'webhooks',
    'maintenance_runs',
    'usage_events',
    'audit_logs',
    'memory_terms',
    'relations',
    'memory_entities',
    'entities',
    'memory_history',
    'memories',
    'api_keys',
    'tasks',
    'agents',
    'project_members',
    'projects',
    'users',
    'orgs',
  ];
  for (const table of tables) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch {
      /* 表可能尚未建立 */
    }
  }
}

function insertAudit(
  db: DatabaseSync,
  entry: {
    projectId?: string;
    actorType: 'user' | 'api_key' | 'system';
    actorId: string;
    actorLabel: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    detail?: Record<string, unknown>;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs
       (id, org_id, project_id, actor_type, actor_id, actor_label, action,
        resource_type, resource_id, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('aud'),
    ORG.id,
    entry.projectId ?? null,
    entry.actorType,
    entry.actorId,
    entry.actorLabel,
    entry.action,
    entry.resourceType,
    entry.resourceId ?? null,
    JSON.stringify(entry.detail ?? {}),
    '10.24.8.31',
    'Mnemos-Seed/1.0',
    entry.createdAt,
  );
}

export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const { db, engine, bus, log } = options;
  const base = `${BASE}`;
  let memories = 0;
  let usageEvents = 0;
  let agentCount = 0;
  let taskCount = 0;
  const taskIdsByProject = new Map<string, Map<string, string>>();

  log?.('清理旧数据…');
  wipe(db);

  log?.('写入组织与成员…');
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    ORG.id,
    ORG.name,
    ORG.slug,
    ORG.plan,
    isoDaysAgo(180),
  );

  const passwordHash = hashPassword(DEMO_PASSWORD);
  for (const user of USERS) {
    db.prepare(
      `INSERT INTO users (id, org_id, email, name, role, title, avatar_color, password_hash, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id,
      ORG.id,
      user.email,
      user.name,
      user.role,
      user.title,
      user.avatarColor,
      passwordHash,
      (user as { status?: string }).status ?? 'active',
      isoDaysAgo(170 + randInt(0, 40)),
      isoDaysAgo(randInt(0, 2)),
    );
  }

  const userByEmail = new Map(USERS.map((u) => [u.email, u]));
  const projectIdBySlug = new Map<string, string>();
  const projectMeta: { slug: string; id: string; name: string; memoryIds: string[] }[] = [];
  let members = 0;

  log?.('创建项目与成员…');
  PROJECTS.forEach((project, index) => {
    const projectId = `prj_${project.slug.replace(/-/g, '_')}`;
    projectIdBySlug.set(project.slug, projectId);
    const createdAt = isoDaysAgo(150 - index * 12);
    db.prepare(
      `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      ORG.id,
      project.slug,
      project.name,
      project.description,
      project.status,
      project.region,
      project.env,
      JSON.stringify(projectSettings(project.settings)),
      createdAt,
      isoDaysAgo(randInt(0, 4)),
      project.status === 'archived' ? isoDaysAgo(10) : null,
    );

    for (const member of project.members) {
      const user = userByEmail.get(member.email);
      if (!user) continue;
      db.prepare(
        'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      ).run(projectId, user.id, member.role, createdAt);
      members += 1;
    }

    for (const key of DEMO_KEYS[project.slug] ?? []) {
      db.prepare(
        `INSERT INTO api_keys
           (id, project_id, name, prefix, key_hash, scopes, created_by, created_at, last_used_at, revoked_at, rate_limit_per_min, expires_at, allowed_ips)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key.id,
        projectId,
        key.name,
        key.secret.slice(0, 18),
        sha256(key.secret),
        JSON.stringify(key.scopes),
        key.createdBy,
        isoDaysAgo(key.daysAgo),
        key.revokedDaysAgo ? isoDaysAgo(key.revokedDaysAgo - 1) : isoDaysAgo(randInt(0, 3)),
        key.revokedDaysAgo ? isoDaysAgo(key.revokedDaysAgo) : null,
        600,
        key.expiresInDays != null ? addDays(nowIso(), key.expiresInDays) : null,
        JSON.stringify(key.allowedIps ?? []),
      );
    }

    // Agent 注册表：显式定义 + 从 persona.agentId 自动登记
    // agents.id 全局唯一，演示数据按项目命名空间隔离（真实 API 由服务端生成唯一 id）
    const scopedAgentId = (raw: string) => `${projectId}__${raw}`;
    const knownAgents = new Set<string>();
    const insertAgent = (agent: SeedAgent, fallbackName: string) => {
      const result = db.prepare(
        `INSERT OR IGNORE INTO agents
           (id, project_id, name, role, model, description, capabilities, status, metadata, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        scopedAgentId(agent.id),
        projectId,
        agent.name || fallbackName,
        agent.role ?? 'assistant',
        agent.model ?? 'deepseek-chat',
        agent.description ?? '',
        JSON.stringify(agent.capabilities ?? []),
        agent.status ?? 'active',
        '{}',
        createdAt,
        isoDaysAgo(randInt(0, 3)),
      );
      knownAgents.add(agent.id);
      if (Number(result.changes) > 0) agentCount += 1;
    };

    for (const agent of project.agents ?? []) insertAgent(agent, agent.id);
    for (const persona of project.personas) {
      if (knownAgents.has(persona.agentId)) continue;
      insertAgent(
        {
          id: persona.agentId,
          name: persona.label,
          role: 'assistant',
          model: 'deepseek-chat',
          description: '',
          capabilities: [],
        },
        persona.agentId,
      );
    }

    // 任务会话（Agent 跨时间段接力的载体）
    const taskIds = new Map<string, string>();
    for (const task of project.tasks ?? []) {
      const startedAt = isoDaysAgo(task.startDaysAgo, -randInt(1, 6));
      const endedAt = task.endDaysAgo != null ? isoDaysAgo(task.endDaysAgo, -randInt(1, 6)) : null;
      db.prepare(
        `INSERT INTO tasks
           (id, project_id, title, goal, status, owner_agent_id, branch, summary, metadata, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        projectId,
        task.title,
        task.goal,
        task.status,
        task.ownerAgentId ? scopedAgentId(task.ownerAgentId) : null,
        task.branch ?? null,
        task.summary ?? null,
        JSON.stringify({ key: task.key }),
        startedAt,
        startedAt,
        endedAt,
      );
      taskIds.set(task.key, task.id);
      taskCount += 1;
    }
    taskIdsByProject.set(project.slug, taskIds);

    // 演示 Webhook 订阅与投递历史
    for (const hook of DEMO_WEBHOOKS[project.slug] ?? []) {
      const createdAt = isoDaysAgo(hook.daysAgo);
      db.prepare(
        `INSERT INTO webhooks
           (id, project_id, name, url, secret, event_types, enabled, description, created_by, created_at, updated_at, last_delivery_at, last_status, failure_count, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hook.id,
        projectId,
        hook.name,
        hook.url,
        hook.secret,
        JSON.stringify(hook.eventTypes),
        hook.enabled ? 1 : 0,
        hook.description,
        hook.createdBy,
        createdAt,
        createdAt,
        hook.deliveries.length > 0 ? new Date(BASE - Math.min(...hook.deliveries.map((d) => d.minutesAgo)) * 60_000).toISOString() : null,
        hook.deliveries[0]?.responseStatus ?? null,
        hook.deliveries.filter((d) => d.status !== 'success').length,
        hook.enabled ? null : isoDaysAgo(5),
      );
      for (const [index, delivery] of hook.deliveries.entries()) {
        const at = new Date(BASE - delivery.minutesAgo * 60_000).toISOString();
        db.prepare(
          `INSERT INTO webhook_deliveries
             (id, webhook_id, project_id, event_type, event_id, payload, status, attempts, max_attempts, next_attempt_at, response_status, response_body, latency_ms, error, created_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId('whd'),
          hook.id,
          projectId,
          delivery.eventType,
          newId('evt'),
          JSON.stringify({
            id: newId('evt'),
            type: delivery.eventType,
            at,
            projectId,
            projectSlug: project.slug,
            actor: hook.createdBy,
            data: { demo: true, index },
          }),
          delivery.status,
          delivery.attempts,
          6,
          delivery.status === 'failed' ? new Date(BASE + 7 * 86_400_000).toISOString() : null,
          delivery.responseStatus ?? null,
          delivery.status === 'success' ? '{"ok":true}' : null,
          delivery.latencyMs ?? null,
          delivery.error ?? null,
          at,
          delivery.status === 'success' ? at : null,
        );
      }
    }

    projectMeta.push({ slug: project.slug, id: projectId, name: project.name, memoryIds: [] });
  });

  log?.('写入策展记忆（抽取 → 索引 → 图谱）…');
  const memoryPatch = db.prepare(
    'UPDATE memories SET created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ? WHERE id = ?',
  );
  const historyPatch = db.prepare('UPDATE memory_history SET created_at = ? WHERE memory_id = ?');

  for (const project of PROJECTS) {
    const projectId = projectIdBySlug.get(project.slug)!;
    const meta = projectMeta.find((m) => m.slug === project.slug)!;
    const taskIds = taskIdsByProject.get(project.slug) ?? new Map<string, string>();
    const scopedAgentId = (raw: string) => `${projectId}__${raw}`;

    for (const [personaIndex, persona] of project.personas.entries()) {
      for (const [factIndex, fact] of persona.facts.entries()) {
        // 每个项目让前 3 位角色的最后一条事实落在最近 1-3 天，保证「近 7 日增长」与最近记忆有内容
        const recentOverride =
          !fact.taskKey && personaIndex < 3 && factIndex === persona.facts.length - 1
            ? personaIndex + 1
            : null;
        const factDaysAgo = recentOverride ?? fact.daysAgo;
        const taskId = fact.taskKey ? (taskIds.get(fact.taskKey) ?? undefined) : undefined;
        const result = await engine.add({
          projectId,
          text: fact.text,
          infer: false,
          userId: persona.userId,
          agentId: scopedAgentId(fact.agentId ?? persona.agentId),
          taskId,
          visibility: fact.visibility ?? 'project',
          appId: project.slug,
          source: 'conversation',
          tags: fact.tags ?? [],
          metadata: {
            category: fact.category,
            importance: fact.importance ?? 0.62,
            confidence: 0.86,
            channel: 'seed',
            persona: persona.label,
          },
          actor: { type: 'system', id: 'seed', label: '演示数据导入' },
        });

        for (const memory of result.results) {
          const createdAt = isoDaysAgo(factDaysAgo, -randInt(1, 9));
          const updatedAt = addDays(createdAt, rng() > 0.85 ? Math.min(randInt(1, 4), factDaysAgo) : 0);
          memoryPatch.run(
            createdAt,
            updatedAt,
            isoDaysAgo(Math.max(0, factDaysAgo - randInt(0, 6))),
            randInt(1, 42),
            memory.id,
          );
          historyPatch.run(createdAt, memory.id);
          meta.memoryIds.push(memory.id);
          memories += 1;
        }
      }
    }

    // 合成补充记忆：模拟长期会话沉淀，增加数据密度（排在较早日期的历史里）
    const synthCount = Math.max(4, Math.round(26 - project.personas.length));
    for (let i = 0; i < synthCount; i += 1) {
      const persona = project.personas[i % project.personas.length]!;
      const template = project.synthTemplates[i % project.synthTemplates.length]!;
      const topic = project.synthTopics[(i * 3 + project.slug.length) % project.synthTopics.length]!;
      const daysAgo = 25 + ((i * 7 + project.slug.length * 3) % 70);
      const name = persona.label.split(' · ')[0] ?? persona.label;
      const text = template
        .replace('{user}', name)
        .replace('{date}', cnDate(daysAgo))
        .replace('{topic}', topic);

      const activeTask = (project.tasks ?? []).find((task) => task.status === 'active');
      const result = await engine.add({
        projectId,
        text,
        infer: false,
        userId: persona.userId,
        agentId: scopedAgentId(persona.agentId),
        taskId: activeTask?.id,
        visibility: 'project',
        appId: project.slug,
        source: i % 3 === 0 ? 'agent' : 'conversation',
        tags: ['会话摘要'],
        metadata: {
          category: 'event',
          importance: 0.48 + (i % 5) * 0.03,
          confidence: 0.78,
          channel: 'seed',
        },
        actor: { type: 'system', id: 'seed', label: '演示数据导入' },
      });
      for (const memory of result.results) {
        const createdAt = isoDaysAgo(daysAgo, -randInt(0, 12));
        memoryPatch.run(createdAt, createdAt, isoDaysAgo(Math.max(0, daysAgo - randInt(0, 8))), randInt(0, 18), memory.id);
        historyPatch.run(createdAt, memory.id);
        meta.memoryIds.push(memory.id);
        memories += 1;
      }
    }
  }

  log?.('生成用量事件（近 30 天）…');
  const usageStmt = db.prepare(
    `INSERT INTO usage_events
       (id, org_id, project_id, api_key_id, channel, operation, method, path, status, latency_ms, result_count, memory_tokens, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const keyIdsByProject = new Map<string, string[]>();
  for (const project of PROJECTS) {
    keyIdsByProject.set(
      project.slug,
      (DEMO_KEYS[project.slug] ?? []).map((k) => k.id),
    );
  }

  tx(db, () => {
    for (const project of PROJECTS) {
      const projectId = projectIdBySlug.get(project.slug)!;
      const scale =
        project.slug === 'aurora-support'
          ? 1
          : project.slug === 'atlas-copilot'
            ? 0.7
            : project.slug === 'helios-knowledge'
              ? 0.42
              : project.slug === 'nova-sales'
                ? 0.24
                : 0.1;
      const apiKeys = keyIdsByProject.get(project.slug) ?? [];

      for (let dayOffset = 29; dayOffset >= 0; dayOffset -= 1) {
        const dayStart = new Date(BASE - dayOffset * DAY);
        const weekday = dayStart.getDay();
        const weekendFactor = weekday === 0 || weekday === 6 ? 0.42 : 1;
        const trend = 1 + (29 - dayOffset) / 55;
        const searches = Math.round(randInt(48, 104) * scale * weekendFactor * trend);
        const adds = Math.round(randInt(5, 15) * scale * weekendFactor * trend);
        const lists = Math.round(randInt(12, 30) * scale * weekendFactor);

        for (let i = 0; i < searches; i += 1) {
          const channel = rng() < 0.74 ? 'api' : rng() < 0.7 ? 'console' : 'playground';
          const keyId = channel === 'api' && apiKeys.length ? pick(apiKeys) : null;
          const failed = rng() < 0.012;
          usageStmt.run(
            newId('use'),
            ORG.id,
            projectId,
            keyId,
            channel,
            'search',
            'POST',
            '/v1/memories/search',
            failed ? (rng() < 0.6 ? 429 : 500) : 200,
            failed ? randInt(2, 12) : randInt(16, 68),
            failed ? 0 : randInt(1, 8),
            failed ? 0 : randInt(160, 980),
            channel === 'console' ? '林薇' : 'api-client',
            isoDaysAgo(dayOffset, -randInt(0, 23)),
          );
          usageEvents += 1;
        }

        for (let i = 0; i < adds; i += 1) {
          const channel = rng() < 0.62 ? 'api' : rng() < 0.6 ? 'console' : 'playground';
          const keyId = channel === 'api' && apiKeys.length ? pick(apiKeys) : null;
          usageStmt.run(
            newId('use'),
            ORG.id,
            projectId,
            keyId,
            channel,
            'add',
            'POST',
            '/v1/memories',
            200,
            randInt(34, 168),
            randInt(1, 6),
            randInt(20, 140),
            channel === 'console' ? '陈昊' : 'api-client',
            isoDaysAgo(dayOffset, -randInt(0, 23)),
          );
          usageEvents += 1;
        }

        for (let i = 0; i < lists; i += 1) {
          usageStmt.run(
            newId('use'),
            ORG.id,
            projectId,
            rng() < 0.5 && apiKeys.length ? pick(apiKeys) : null,
            rng() < 0.5 ? 'console' : 'api',
            'list',
            'GET',
            '/v1/memories',
            200,
            randInt(8, 42),
            randInt(1, 20),
            randInt(40, 260),
            '林薇',
            isoDaysAgo(dayOffset, -randInt(0, 23)),
          );
          usageEvents += 1;
        }
      }
    }
  });

  log?.('生成审计日志…');
  const actorPool = USERS.map((u) => ({ id: u.id, label: u.name, type: 'user' as const }));
  let auditEvents = 0;
  for (const project of projectMeta) {
    const picks = [
      ['memory.create', 'memory'],
      ['memory.search', 'memory'],
      ['memory.update', 'memory'],
      ['key.create', 'api_key'],
      ['settings.update', 'project'],
      ['member.add', 'member'],
      ['memory.delete', 'memory'],
      ['project.update', 'project'],
    ] as const;

    for (let i = 0; i < 11; i += 1) {
      const actor = pick(actorPool);
      const [action, resourceType] = picks[(i + project.slug.length) % picks.length]!;
      const createdAt = isoDaysAgo(randInt(0, 26), -randInt(0, 23));
      insertAudit(db, {
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorLabel: actor.label,
        action,
        resourceType,
        resourceId: resourceType === 'memory' ? project.memoryIds[i % Math.max(1, project.memoryIds.length)] : undefined,
        detail: {
          projectName: project.name,
          source: action === 'memory.search' ? 'console' : 'api',
          requestId: `req_${base.slice(-6)}_${i}`,
        },
        createdAt,
      });
      auditEvents += 1;
    }

    if (project.slug === 'aurora-support') {
      insertAudit(db, {
        projectId: project.id,
        actorType: 'api_key',
        actorId: 'key_aurora_legacy',
        actorLabel: '旧版工单机器人',
        action: 'memory.create',
        resourceType: 'memory',
        resourceId: project.memoryIds[0],
        detail: { channel: 'api', scopes: ['memories:write'] },
        createdAt: isoDaysAgo(2, 5),
      });
      auditEvents += 1;
    }
  }

  // 让控制台「实时事件」在首屏就有内容
  const liveEvents: LiveEvent[] = projectMeta
    .filter((p) => p.memoryIds.length > 0)
    .slice(0, 4)
    .map((project, i) => ({
      id: newId('evt'),
      type: i % 2 === 0 ? 'memory.added' : 'search.performed',
      projectId: project.id,
      projectName: project.name,
      actor: i % 2 === 0 ? '陈昊' : 'Aurora 客服机器人',
      summary:
        i % 2 === 0
          ? `写入 1 条记忆到「${project.name}」`
          : `在「${project.name}」完成一次混合检索（p50 32ms）`,
      at: new Date(BASE - i * 47_000).toISOString(),
      meta: { scope: 'project' },
    }));
  for (const event of liveEvents) bus.publish(event);

  log?.(`完成：${memories} 条记忆 / ${usageEvents} 条用量 / ${auditEvents} 条审计`);

  return {
    projects: PROJECTS.length,
    members,
    agents: agentCount,
    tasks: taskCount,
    memories,
    usageEvents,
    auditEvents,
    demoApiKey: { projectSlug: 'aurora-support', secret: 'mnemos_live_demo_aurora_console' },
  };
}

export { DEMO_PASSWORD, PROJECTS, USERS };
export type { SeedFact, MemoryCategory, Role };
