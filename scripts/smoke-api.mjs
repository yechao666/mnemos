#!/usr/bin/env node
/**
 * 端到端冒烟测试：启动真实服务（独立端口/临时数据目录），覆盖控制台与公开 API。
 * 零依赖：node scripts/smoke-api.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.SMOKE_PORT ?? 4391);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = resolve('.run/smoke');
const DEMO_KEY = 'mnemos_live_demo_aurora_console';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') {
  passed += 1;
  console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`);
}

function bad(name, error) {
  failed += 1;
  failures.push({ name, error });
  console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    bad(name, error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`等待服务超时：${url}`);
}

async function call(path, { method = 'GET', token, key, body, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`\n启动服务 :${PORT}（数据目录 ${DATA_DIR}）…`);
  const child = spawn(process.execPath, ['server/src/main.ts'], {
    env: {
      ...process.env,
      MNEMOS_PORT: String(PORT),
      MNEMOS_HOST: '127.0.0.1',
      MNEMOS_DATA_DIR: DATA_DIR,
      MNEMOS_DB_PATH: resolve(DATA_DIR, 'smoke.db'),
      MNEMOS_DEMO: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let token = null;
  let projectId = null;
  let memoryId = null;
  let searchTook = 0;

  try {
    await waitFor(`${BASE}/api/health`, 45000);
    await sleep(600);

    console.log('\n[1] 健康与认证');
    await check('GET /api/health', async () => {
      const r = await call('/api/health');
      assert(r.status === 200 && r.body?.ok === true, `unexpected: ${r.status} ${JSON.stringify(r.body)}`);
      return `uptime ${Math.round((r.body.uptimeMs ?? 0) / 1000)}s`;
    });

    await check('POST /api/auth/login', async () => {
      const r = await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'lin.wei@mnemos.dev', password: 'mnemos-demo' },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(typeof r.body?.token === 'string' && r.body.token.length > 20, 'token 缺失');
      assert(r.body?.user?.name === '林薇', '用户信息不正确');
      token = r.body.token;
      return r.body.user.name;
    });

    await check('GET /api/auth/me', async () => {
      const r = await call('/api/auth/me', { token });
      assert(r.status === 200 && Array.isArray(r.body?.projects), 'projects 缺失');
      assert(r.body.projects.length >= 5, `项目数量 ${r.body.projects.length}`);
      projectId = r.body.projects[0].id;
      return `${r.body.org.name} · ${r.body.projects.length} 个项目`;
    });

    await check('GET /api/dashboard', async () => {
      const r = await call('/api/dashboard', { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert((r.body?.totals?.memories ?? 0) > 100, `记忆总数 ${r.body?.totals?.memories}`);
      assert(Array.isArray(r.body?.usage) && r.body.usage.length >= 27, 'usage 序列不足');
      assert(Array.isArray(r.body?.projects) && r.body.projects.length >= 5, 'projects 缺失');
      return `${r.body.totals.memories} 条记忆 / 7 日检索 ${r.body.totals.searches7d}`;
    });

    console.log('\n[2] 项目与概览');
    await check('GET /api/projects', async () => {
      const r = await call('/api/projects', { token });
      assert(r.status === 200 && Array.isArray(r.body) && r.body.length >= 5, 'projects 数组异常');
      const p = r.body.find((x) => x.id === projectId);
      assert(p?.stats?.memories > 0, '项目统计缺失');
      return `${r.body.length} 个项目`;
    });

    await check('GET /api/projects/:id/overview', async () => {
      const r = await call(`/api/projects/${projectId}/overview`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(Array.isArray(r.body?.categories) && r.body.categories.length > 0, '分类缺失');
      assert(Array.isArray(r.body?.topEntities) && r.body.topEntities.length > 0, '实体缺失');
      assert(Array.isArray(r.body?.recentMemories) && r.body.recentMemories.length > 0, '最近记忆缺失');
      return `${r.body.stats.memories} 记忆 / ${r.body.stats.entities} 实体 / ${r.body.stats.relations} 关系`;
    });

    await check('GET /api/projects/:id/usage', async () => {
      const r = await call(`/api/projects/${projectId}/usage?days=30`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.points?.length >= 27, '用量序列不足');
      assert((r.body?.totals?.searches ?? 0) > 100, '检索用量过低');
      assert(r.body?.latency?.p50 > 0, 'p50 缺失');
      return `检索 ${r.body.totals.searches} 次 · p50 ${r.body.latency.p50}ms`;
    });

    await check('GET /api/projects/:id/audit', async () => {
      const r = await call(`/api/projects/${projectId}/audit?page=1&pageSize=10`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.items?.length > 0, '审计为空');
      return `${r.body.total} 条审计`;
    });

    console.log('\n[3] 记忆浏览与检索');
    await check('GET /api/projects/:id/memories', async () => {
      const r = await call(`/api/projects/${projectId}/memories?page=1&pageSize=10`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.items?.length === 10, `items ${r.body?.items?.length}`);
      memoryId = r.body.items[0].id;
      return `total ${r.body.total}`;
    });

    await check('中文混合检索命中', async () => {
      const r = await call(`/api/projects/${projectId}/memories?q=${encodeURIComponent('周报 格式 偏好')}&pageSize=5`, {
        token,
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      const items = r.body?.items ?? [];
      assert(items.length > 0, '检索无结果');
      const top = items[0];
      assert(top.content.includes('周报'), `首位内容不相关：${top.content}`);
      searchTook = r.body.tookMs ?? 0;
      return `命中 ${items.length} 条 · ${searchTook}ms · 首位「${top.content.slice(0, 18)}…」`;
    });

    await check('GET /api/memories/:id 详情', async () => {
      const r = await call(`/api/memories/${memoryId}`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.memory?.content, '内容缺失');
      assert(Array.isArray(r.body.history) && r.body.history.length > 0, '历史缺失');
      return `历史 ${r.body.history.length} 条 · 实体 ${r.body.entities.length} 个`;
    });

    await check('PATCH /api/memories/:id 更新', async () => {
      const r = await call(`/api/memories/${memoryId}`, {
        method: 'PATCH',
        token,
        body: { importance: 0.77, tags: ['smoke', 'api'] },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(Math.abs(r.body.importance - 0.77) < 0.001, 'importance 未更新');
      assert(r.body.tags.includes('smoke'), 'tags 未更新');
      return '更新成功';
    });

    await check('POST /api/memories/:id/feedback', async () => {
      const r = await call(`/api/memories/${memoryId}/feedback`, {
        method: 'POST',
        token,
        body: { helpful: true },
      });
      assert(r.status === 200 && r.body.importance > 0.77, '反馈未生效');
      return `importance → ${r.body.importance}`;
    });

    console.log('\n[4] 图谱、密钥、演练场');
    await check('GET /api/projects/:id/graph', async () => {
      const r = await call(`/api/projects/${projectId}/graph?limit=60`, { token });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.nodes?.length > 5, `节点 ${r.body?.nodes?.length}`);
      assert(r.body?.edges?.length > 0, '边为空');
      return `${r.body.nodes.length} 节点 / ${r.body.edges.length} 边`;
    });

    await check('POST /api/projects/:id/keys', async () => {
      const r = await call(`/api/projects/${projectId}/keys`, {
        method: 'POST',
        token,
        body: { name: 'S smoke key', scopes: ['memories:read', 'memories:write'] },
      });
      assert(r.status === 200 || r.status === 201, `HTTP ${r.status}`);
      assert(typeof r.body?.secret === 'string' && r.body.secret.startsWith('mnemos_live_'), 'secret 缺失');
      return r.body.prefix;
    });

    await check('POST playground add + search', async () => {
      const add = await call(`/api/projects/${projectId}/playground/add`, {
        method: 'POST',
        token,
        body: {
          messages: [
            {
              role: 'user',
              content: '我偏好每周一上午收到服务质量周报，格式为 CSV，并附三点结论。',
            },
          ],
          userId: 'smoke-user',
          agentId: 'smoke-agent',
          infer: true,
        },
      });
      assert(add.status === 200, `add HTTP ${add.status}`);
      assert((add.body?.results?.length ?? 0) > 0, '未写入记忆');
      const search = await call(`/api/projects/${projectId}/playground/search`, {
        method: 'POST',
        token,
        body: { query: '周报偏好', userId: 'smoke-user', topK: 5 },
      });
      assert(search.status === 200, `search HTTP ${search.status}`);
      assert((search.body?.results?.length ?? 0) > 0, '检索无结果');
      assert(search.body.results[0].signals?.semantic >= 0, 'signals 缺失');
      return `${add.body.results.length} 条写入 · ${search.body.results.length} 条命中 · ${search.body.tookMs}ms`;
    });

    console.log('\n[5] Agent 原生：注册表 / 任务 / 简报 / 可见性');
    const ORION_KEY = 'mnemos_live_demo_orion_python';
    const ORION_ID = 'prj_orion_python';
    let agentId = 'agent-coder';
    let taskId = '';

    await check('GET /v1/agents（Python 项目）', async () => {
      const r = await call('/v1/agents', { key: ORION_KEY });
      assert(r.status === 200, `HTTP ${r.status}`);
      const agents = r.body.results ?? r.body.agents ?? r.body;
      assert(Array.isArray(agents), 'agents 缺失');
      assert(agents.length >= 4, `agent 数量 ${agents.length}`);
      const coder = agents.find((a) => a.name?.includes('开发') || a.role === 'developer');
      assert(coder, '未找到开发 Agent');
      agentId = coder.id;
      return `${agents.length} 个 Agent · ${coder.name}`;
    });

    await check('POST /v1/agents 注册新 Agent', async () => {
      const r = await call('/v1/agents', {
        method: 'POST',
        key: ORION_KEY,
        body: { name: `冒烟 Agent ${Date.now() % 10000}`, role: 'tester', capabilities: ['smoke'] },
      });
      assert(r.status === 200 || r.status === 201, `HTTP ${r.status}`);
      const agent = r.body.agent ?? r.body;
      assert(agent.id, 'id 缺失');
      return agent.name;
    });

    await check('POST /v1/tasks 开始任务', async () => {
      const r = await call('/v1/tasks', {
        method: 'POST',
        key: ORION_KEY,
        body: {
          title: '冒烟任务：验证跨 Agent 记忆共享',
          goal: '确认任务简报会带回历史决策与事故经验',
          owner_agent_id: agentId,
          branch: 'test/smoke',
        },
      });
      assert(r.status === 200 || r.status === 201, `HTTP ${r.status}`);
      const task = r.body.task ?? r.body;
      assert(task.id, 'task id 缺失');
      taskId = task.id;
      return task.title;
    });

    await check('POST /v1/memories（任务私有 + 任务内可见）', async () => {
      const privateRes = await call('/v1/memories', {
        method: 'POST',
        key: ORION_KEY,
        body: {
          text: '私有草稿：先按 order_id 分片，跨分片统计用离线汇总。',
          agent_id: agentId,
          task_id: taskId,
          visibility: 'agent',
        },
      });
      assert(privateRes.status === 200, `private HTTP ${privateRes.status}`);
      const shared = await call('/v1/memories', {
        method: 'POST',
        key: ORION_KEY,
        body: {
          text: '冒烟结论：查询拆分前必须冻结接口契约，并补齐双写对账。',
          agent_id: agentId,
          task_id: taskId,
          visibility: 'project',
        },
      });
      assert(shared.status === 200, `shared HTTP ${shared.status}`);
      return '写入 1 条私有 + 1 条共享';
    });

    await check('可见性：其他 Agent 看不到私有记忆', async () => {
      const other = await call('/v1/memories/search', {
        method: 'POST',
        key: ORION_KEY,
        body: { query: '私有草稿 跨分片 统计', agent_id: 'agent-arch', top_k: 10 },
      });
      assert(other.status === 200, `HTTP ${other.status}`);
      const leaked = (other.body?.results ?? []).filter((hit) => String(hit.memory ?? hit.content).includes('私有草稿'));
      assert(leaked.length === 0, '私有记忆泄漏给其他 Agent');
      const own = await call('/v1/memories/search', {
        method: 'POST',
        key: ORION_KEY,
        body: { query: '私有草稿 跨分片 统计', agent_id: agentId, top_k: 10 },
      });
      assert((own.body?.results ?? []).length > 0, '写入者自己也查不到私有记忆');
      return '隔离与自读均正确';
    });

    await check('跨 Agent 共享：开发 Agent 能看到架构师的决策', async () => {
      const r = await call('/v1/memories/search', {
        method: 'POST',
        key: ORION_KEY,
        body: { query: 'FastAPI SQLAlchemy 架构决策', agent_id: agentId, top_k: 10 },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      const text = (r.body?.results ?? []).map((hit) => String(hit.memory ?? hit.content)).join(' ');
      assert(text.includes('FastAPI') || text.includes('SQLAlchemy'), '未检索到其他 Agent 的项目共享记忆');
      return '架构决策跨 Agent 可见';
    });

    await check('POST /v1/context 任务简报', async () => {
      const r = await call('/v1/context', {
        method: 'POST',
        key: ORION_KEY,
        body: {
          agent_id: agentId,
          task_id: 'task_orion_split_query',
          query: '拆分查询服务 接口契约 对账',
          budget_tokens: 1200,
        },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(typeof r.body?.prompt === 'string' && r.body.prompt.length > 100, 'prompt 为空');
      assert(Array.isArray(r.body?.sections) && r.body.sections.length >= 4, 'sections 不足');
      assert((r.body?.token_estimate ?? r.body?.tokenEstimate ?? 0) > 0, 'token 估算缺失');
      assert(r.body.prompt.includes('冻结查询接口契约') || r.body.prompt.includes('库存超卖'), '简报未带回历史经验');
      return `${r.body.sections.length} 个段落 · ${r.body.token_estimate ?? r.body.tokenEstimate} tokens`;
    });

    await check('POST /v1/tasks/{id}/finish 沉淀经验', async () => {
      const r = await call(`/v1/tasks/${taskId}/finish`, {
        method: 'POST',
        key: ORION_KEY,
        body: {
          summary: '冒烟任务完成：确认跨 Agent 共享与简报。',
          decisions: ['查询服务拆分采用 read replica + order_id 分片。'],
          lessons: ['拆分前必须补齐双写对账脚本，上次漏了退款单。'],
          agent_id: agentId,
        },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert((r.body?.memories?.length ?? 0) >= 2, '决策/教训未写入记忆');
      const task = r.body.task ?? r.body;
      assert(task.status === 'done', `任务状态 ${task.status}`);
      return `写入 ${r.body.memories.length} 条沉淀记忆`;
    });

    await check('控制台 Agent / 任务 / 简报接口', async () => {
      const agents = await call(`/api/projects/${ORION_ID}/agents`, { token });
      assert(agents.status === 200 && agents.body.length >= 4, `agents HTTP ${agents.status}`);
      const tasks = await call(`/api/projects/${ORION_ID}/tasks`, { token });
      assert(tasks.status === 200 && tasks.body.length >= 5, `tasks HTTP ${tasks.status}`);
      const arch = agents.body.find((a) => a.role === 'architect') ?? agents.body[0];
      const briefing = await call(
        `/api/projects/${ORION_ID}/briefing?agentId=${encodeURIComponent(arch.id)}&taskId=task_orion_split_query`,
        { token },
      );
      assert(briefing.status === 200 && briefing.body.prompt, `briefing HTTP ${briefing.status}`);
      return `${agents.body.length} Agent / ${tasks.body.length} 任务 / 简报 ${briefing.body.tokenEstimate ?? briefing.body.token_estimate} tokens`;
    });

    console.log('\n[6] 生产平台：探针 / 指标 / 安全 / 运维');
    let prodKey = null;

    await check('健康探针与指标', async () => {
      const live = await call('/healthz');
      assert(live.status === 200 && live.body?.ok === true, `healthz ${live.status}`);
      const ready = await call('/readyz');
      assert(ready.status === 200 && ready.body?.checks?.db?.ok === true, `readyz ${ready.status}`);
      const metrics = await fetch(`${BASE}/metrics`);
      const text = await metrics.text();
      assert(metrics.status === 200 && text.includes('mnemos_http_requests_total'), '/metrics 异常');
      assert(text.includes('mnemos_build_info'), '缺少 build_info');
      return 'healthz/readyz/metrics 正常';
    });

    await check('安全响应头与 OpenAPI', async () => {
      const res = await fetch(`${BASE}/`);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert(csp.includes('default-src'), '缺少 CSP');
      assert(res.headers.get('x-frame-options') === 'DENY', '缺少 X-Frame-Options');
      assert(res.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
      const spec = await call('/openapi.json');
      assert(spec.status === 200, `openapi ${spec.status}`);
      assert(Object.keys(spec.body.paths ?? {}).length >= 25, 'OpenAPI paths 不足');
      return `CSP + ${Object.keys(spec.body.paths).length} 个路径`;
    });

    await check('API Key 生命周期（过期/IP/轮换）', async () => {
      const created = await call(`/api/projects/${ORION_ID}/keys`, {
        method: 'POST',
        token,
        body: {
          name: 'su 冒烟轮换',
          scopes: ['memories:read', 'memories:write'],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowedIps: ['127.0.0.1', '10.0.0.0/8'],
          rateLimitPerMin: 120,
        },
      });
      assert(created.status === 201, `create ${created.status}`);
      assert(created.body.expiresAt && created.body.allowedIps.length === 2, '生命周期字段缺失');
      const limited = await fetch(`${BASE}/v1/agents`, {
        headers: { authorization: `Bearer ${created.body.secret}` },
      });
      assert(limited.status === 200, `allowlisted call ${limited.status}`);
      assert(limited.headers.get('x-ratelimit-limit') === '120', '缺少限流响应头');
      const rotated = await call(`/api/projects/${ORION_ID}/keys/${created.body.id}/rotate`, {
        method: 'POST',
        token,
        body: { graceHours: 24 },
      });
      assert(rotated.status === 201 && rotated.body.secret !== created.body.secret, '轮换失败');
      assert(rotated.body.rotatedFrom === created.body.id, 'rotatedFrom 缺失');
      prodKey = rotated.body.secret;
      return `轮换后前缀 ${rotated.body.prefix}`;
    });

    await check('幂等键：重复请求回放', async () => {
      const key = `smoke-idem-${Date.now()}`;
      const payload = { text: `幂等冒烟 ${key}`, user_id: 'smoke-idem' };
      const first = await call('/v1/memories', {
        method: 'POST',
        key: prodKey,
        body: payload,
        headers: { 'idempotency-key': key },
      });
      const second = await call('/v1/memories', {
        method: 'POST',
        key: prodKey,
        body: payload,
        headers: { 'idempotency-key': key },
      });
      assert(first.status === 200 && second.status === 200, `${first.status}/${second.status}`);
      assert(second.headers.get('x-idempotent-replayed') === 'true', '未标记 replay');
      assert(first.body.results[0].id === second.body.results[0].id, '回放 id 不一致');
      return `replay ${second.headers.get('x-idempotent-replayed')}`;
    });

    await check('导出 / 导入（去重）', async () => {
      const exp = await call(`/api/projects/${ORION_ID}/export`, { token });
      assert(exp.status === 200 && exp.body.format === 'mnemos-export/v1', '导出格式错误');
      assert(exp.body.memories.length > 10, '导出记忆过少');
      const imp = await call('/v1/import', {
        method: 'POST',
        key: prodKey,
        body: { memories: exp.body.memories.slice(0, 3) },
      });
      assert(imp.status === 200, `import ${imp.status}`);
      assert(imp.body.imported + imp.body.skipped === 3, '导入计数异常');
      return `导出 ${exp.body.memories.length} 条 · 导入跳过 ${imp.body.skipped}`;
    });

    await check('运维状态 / 维护 dryRun / 备份', async () => {
      const status = await call('/api/ops/status', { token });
      assert(status.status === 200 && status.body.database.schemaVersion >= 2, 'ops status 异常');
      assert(Array.isArray(status.body.quotas) && status.body.quotas.length >= 6, '配额缺失');
      const dry = await call('/api/ops/maintenance', { method: 'POST', token, body: { dryRun: true } });
      assert(dry.status === 200 && dry.body.dryRun === true, '维护 dryRun 异常');
      const backup = await call('/api/ops/backup', { method: 'POST', token, body: {} });
      assert(backup.status === 200 && backup.body.sizeBytes > 0, '备份失败');
      const list = await call('/api/ops/backups', { token });
      assert(list.status === 200 && list.body.length >= 1, '备份列表为空');
      return `schema v${status.body.database.schemaVersion} · 备份 ${backup.body.file}`;
    });

    await check('组织成员 / 登录锁定', async () => {
      const email = `smoke-${Date.now()}@mnemos.dev`;
      const created = await call('/api/org/users', {
        method: 'POST',
        token,
        body: { email, name: '冒烟成员', role: 'developer', password: 'SmokePass123' },
      });
      assert(created.status === 201, `create user ${created.status}`);
      const users = await call('/api/org/users', { token });
      assert(users.status === 200 && users.body.some((user) => user.email === email), '成员列表缺少新用户');
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await call('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-pass' } });
      }
      assert(last.status === 423, `锁定状态 ${last.status}`);
      assert(last.body.error.code === 'account_locked', '锁定错误码异常');
      const reset = await call(`/api/org/users/${created.body.user.id}/reset-password`, { method: 'POST', token });
      assert(reset.status === 200 && reset.body.temporaryPassword.length >= 12, '重置密码失败');
      return `锁定 + 重置 ${reset.body.temporaryPassword.length} 位临时密码`;
    });

    console.log('\n[7] 公开 v1 API（API Key）');
    await check('POST /v1/memories/search', async () => {
      const r = await call('/v1/memories/search', {
        method: 'POST',
        key: DEMO_KEY,
        body: { query: '客户的退款流程要求', top_k: 5 },
      });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.results?.length > 0, '无结果');
      return `${r.body.results.length} 条命中`;
    });

    await check('POST /v1/memories 写入', async () => {
      const r = await call('/v1/memories', {
        method: 'POST',
        key: DEMO_KEY,
        body: { text: '冒烟测试写入：客户希望每周五下午进行对账。', user_id: 'smoke-v1' },
      });
      assert(r.status === 200 || r.status === 201, `HTTP ${r.status}`);
      assert(r.body?.results?.length === 1, '写入结果异常');
      return r.body.results[0].id;
    });

    await check('GET /v1/memories 列表', async () => {
      const r = await call('/v1/memories?user_id=smoke-v1&page=1&page_size=10', { key: DEMO_KEY });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.body?.results?.length >= 1, '列表为空');
      return `${r.body.results.length} 条`;
    });

    await check('GET /v1/stats（admin 作用域）', async () => {
      const r = await call('/v1/stats', { key: 'mnemos_live_demo_atlas_ci' });
      assert(r.status === 200, `HTTP ${r.status}`);
      assert((r.body?.metrics?.total_memories ?? 0) > 0, '统计缺失');
      return `${r.body.metrics.total_memories} 条记忆 · p50 ${r.body.metrics.recall_p50_ms}ms`;
    });

    await check('作用域不足时 stats 返回 403', async () => {
      const r = await call('/v1/stats', { key: DEMO_KEY });
      assert(r.status === 403, `expected 403, got ${r.status}`);
      return 'memories:read 无法读取统计';
    });

    await check('越权访问被拒绝', async () => {
      const r = await call('/api/dashboard');
      assert(r.status === 401, `expected 401, got ${r.status}`);
      const bad = await call('/v1/memories/search', {
        method: 'POST',
        key: 'mnemos_live_invalid_key',
        body: { query: 'x' },
      });
      assert(bad.status === 401, `invalid key expected 401, got ${bad.status}`);
      return '未认证请求返回 401';
    });

    await check('静态资源 / SPA 回退', async () => {
      const res = await fetch(`${BASE}/projects/does-not-exist`);
      const html = await res.text();
      assert(res.status === 200 && html.includes('<div id="root">'), 'SPA 回退异常');
      return 'index.html 正常返回';
    });
  } catch (error) {
    bad('冒烟流程中断', error);
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    if (!child.killed) child.kill('SIGKILL');
    if (failed > 0) {
      console.error('\n--- 服务端日志（末尾）---');
      console.error(logs.join('').split('\n').slice(-40).join('\n'));
    }
  }

  const total = passed + failed;
  console.log(`\n结果：${passed}/${total} 项通过${failed ? `，${failed} 项失败` : ''}`);
  if (failed) {
    console.error('\n失败项：');
    for (const f of failures) console.error(` - ${f.name}: ${f.error?.message ?? f.error}`);
  }
  process.exit(failed ? 1 : 0);
}

main();
