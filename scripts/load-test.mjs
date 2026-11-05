#!/usr/bin/env node
/**
 * Mnemos 零依赖压测脚本
 * ---------------------------------------------------------------------------
 * 完全基于 Node 内置 fetch / performance，无需 k6、autocannon 或任何 npm 包。
 *
 * 流量模型（只读，避免污染业务数据）：
 *   - 70% 搜索：GET /api/projects/:id/memories?q=…（控制台混合检索）
 *   - 20% 列表：GET /api/projects/:id/memories
 *   - 10% 概览：GET /api/projects/:id/overview
 *
 * 说明：控制台的搜索/列表接口会写入 usage_events（用量统计），这是正常业务行为；
 * 本脚本不会写入、修改或删除任何记忆。建议在预发/压测环境运行，避免污染演示数据。
 *
 * 用法：
 *   node scripts/load-test.mjs
 *   node scripts/load-test.mjs --base http://127.0.0.1:4380 --concurrency 32 --duration 30
 *   node scripts/load-test.mjs --mix 80:15:5 --max-p95-ms 300 --max-error-rate 0.5%
 *
 * 退出码：
 *   0  达到阈值
 *   1  p95 或错误率超过阈值 / 没有发出任何请求
 *   2  参数、登录或项目选择失败
 */
import { setTimeout as sleep } from 'node:timers/promises';

const HELP = `
Mnemos 压测脚本（零依赖）

选项：
  --base <url>              目标地址，默认 http://127.0.0.1:4380
  --concurrency <n>         并发 worker 数，默认 16
  --duration <秒>           持续时长，默认 10
  --mix <search:add:list>   混合比例，默认 70:20:10（第二项保持为只读查询，不会写数据）
  --max-p95-ms <ms>         p95 延迟阈值，默认 500（兼容 --max-p95）
  --max-error-rate <rate>   错误率阈值，默认 1%（支持 1% 或 0.01）
  --email <email>           控制台登录邮箱，默认 lin.wei@mnemos.dev
  --password <pwd>          控制台登录密码，默认 mnemos-demo
  --project <slug>          优先选择的项目 slug，默认 orion-python（找不到则取第一个）
  --timeout <ms>            单请求超时，默认 15000
  --token <token>           跳过登录，直接使用已有控制台会话令牌
  -h, --help                显示帮助

示例：
  node scripts/load-test.mjs --concurrency 32 --duration 30
  node scripts/load-test.mjs --max-p95-ms 250 --max-error-rate 0.5%
`;

const DEFAULTS = {
  base: 'http://127.0.0.1:4380',
  concurrency: 16,
  duration: 10,
  mix: '70:20:10',
  maxP95: 500,
  maxErrorRate: 0.01,
  email: 'lin.wei@mnemos.dev',
  password: 'mnemos-demo',
  projectSlug: 'orion-python',
  timeout: 15_000,
  token: '',
};

const NUMERIC_FIELDS = new Set(['concurrency', 'duration', 'maxP95', 'timeout']);

function fail(message, code = 2) {
  console.error(`\n✗ ${message}\n`);
  process.exit(code);
}

function parseErrorRate(raw) {
  const text = String(raw).trim();
  if (text.endsWith('%')) {
    const value = Number(text.slice(0, -1));
    if (!Number.isFinite(value) || value < 0) throw new Error(`--max-error-rate 非法：${raw}`);
    return value / 100;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--max-error-rate 非法：${raw}`);
  // 兼容 “1” 这种百分数写法；0.01 与 1% 等价。
  return value > 1 ? value / 100 : value;
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const alias = {
    '--max-p95': 'maxP95',
    '--max-p95-ms': 'maxP95',
    '--error-rate': 'maxErrorRate',
    '--max-error-rate': 'maxErrorRate',
    '--project-slug': 'projectSlug',
    '--request-timeout': 'timeout',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (!arg.startsWith('--')) fail(`无法识别的参数：${arg}\n${HELP}`);

    const eq = arg.indexOf('=');
    const rawKey = eq >= 0 ? arg.slice(0, eq) : arg;
    const name = alias[rawKey] ?? rawKey.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!(name in opts)) fail(`未知选项：${rawKey}\n${HELP}`);

    let value;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === '') fail(`选项 ${rawKey} 缺少取值`);

    if (name === 'maxErrorRate') opts[name] = parseErrorRate(value);
    else if (NUMERIC_FIELDS.has(name)) opts[name] = Number(value);
    else opts[name] = value;
  }

  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 512) {
    fail('--concurrency 必须是 1–512 的整数');
  }
  if (!Number.isFinite(opts.duration) || opts.duration <= 0 || opts.duration > 3600) {
    fail('--duration 必须在 0–3600 秒之间');
  }
  if (!Number.isFinite(opts.maxP95) || opts.maxP95 <= 0) fail('--max-p95-ms 必须为正数');
  if (!Number.isFinite(opts.maxErrorRate) || opts.maxErrorRate < 0 || opts.maxErrorRate > 1) {
    fail('--max-error-rate 必须在 0–100% 之间');
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout < 1000) fail('--timeout 至少 1000ms');
  try {
    opts.mixWeights = parseMix(opts.mix);
  } catch (error) {
    fail(error.message);
  }
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

function parseMix(text) {
  const parts = String(text)
    .split(':')
    .map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`--mix 需要三个非负数（search:add:list），收到：${text}`);
  }
  const total = parts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) throw new Error('--mix 三项之和必须大于 0');
  return parts.map((n) => n / total);
}

/** fixed 步长的中文列对齐（按显示宽度补齐，避免表格错位）。 */
function padEndDisplay(text, width) {
  const value = String(text);
  let displayWidth = 0;
  for (const char of value) {
    displayWidth += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char)
      ? 2
      : 1;
  }
  return value + ' '.repeat(Math.max(0, width - displayWidth));
}

function pickAction(weights) {
  const roll = Math.random();
  if (roll < weights[0]) return 'search';
  if (roll < weights[0] + weights[1]) return 'list';
  return 'overview';
}

function getTokenFromResponse(body) {
  return typeof body?.token === 'string' ? body.token : '';
}

function sleepSafe(ms) {
  return sleep(ms);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  async function request(path, { method = 'GET', token, body, headers = {}, parseJson = false } = {}) {
    const started = performance.now();
    try {
      const response = await fetch(`${opts.base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout),
      });
      const text = await response.text();
      let json = null;
      if (parseJson && text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        ms: performance.now() - started,
        headers: response.headers,
        text,
        json,
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        ms: performance.now() - started,
        headers: new Headers(),
        text: '',
        json: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- 目标可达性 & 认证 ---------------------------------------------------
  const health = await request('/api/health', { parseJson: true });
  if (health.status === 0) {
    fail(`无法连接 ${opts.base}：${health.error ?? '连接失败'}\n请先启动服务：node server/src/main.ts`);
  }
  if (!health.ok) fail(`健康检查失败：HTTP ${health.status}\n${health.text.slice(0, 300)}`);

  let token = opts.token;
  if (!token) {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: opts.email, password: opts.password },
      parseJson: true,
    });
    if (login.status !== 200) {
      fail(`登录失败（HTTP ${login.status}）：${login.json?.error?.message ?? login.text.slice(0, 300)}`);
    }
    token = getTokenFromResponse(login.json);
    if (!token) fail('登录响应中缺少 token');
  }

  const projects = await request('/api/projects', { token, parseJson: true });
  if (projects.status !== 200 || !Array.isArray(projects.json)) {
    fail(`读取项目列表失败（HTTP ${projects.status}）：${projects.json?.error?.message ?? projects.text.slice(0, 300)}`);
  }
  const project =
    projects.json.find((item) => item?.slug === opts.projectSlug) ??
    projects.json.find((item) => typeof item?.name === 'string' && /orion/i.test(item.name)) ??
    projects.json[0];
  if (!project?.id) fail('没有可用项目，无法压测');

  // --- 预热（不计入统计） --------------------------------------------------
  const probe = await request(`/api/projects/${project.id}/memories?q=${encodeURIComponent('订单')}&page=1&pageSize=10`, {
    token,
  });
  if (probe.status === 401) fail('会话令牌无效（401），请检查账号密码或 --token');
  if (!probe.ok) fail(`预热请求失败：HTTP ${probe.status}\n${probe.text.slice(0, 300)}`);

  const queries = ['订单', '幂等', '库存超卖', '支付回调', 'Python 升级', '部署', '数据库迁移', '代码评审'];
  const projectPath = `/api/projects/${project.id}`;
  const percent = opts.mixWeights.map((weight) => `${Math.round(weight * 100)}%`);

  console.log('');
  console.log('Mnemos 压测');
  console.log(`  目标      ${opts.base}`);
  console.log(`  项目      ${project.name ?? project.id}（${project.slug ?? project.id}）`);
  console.log(`  并发      ${opts.concurrency}`);
  console.log(`  时长      ${opts.duration}s`);
  console.log(`  混合      搜索 ${percent[0]} / 列表 ${percent[1]} / 概览 ${percent[2]}`);
  console.log('  说明      只读取记忆；搜索/列表会写入 usage_events（用量统计），不修改记忆内容');
  console.log(`  阈值      p95 ≤ ${opts.maxP95}ms，错误率 ≤ ${(opts.maxErrorRate * 100).toFixed(2)}%`);
  console.log('');
  console.log('  预热完成，开始压测…');

  // --- 压测主体 ------------------------------------------------------------
  const latencies = [];
  const statuses = new Map();
  const actionCounts = { search: 0, list: 0, overview: 0 };
  const errors = [];
  let total = 0;
  let errorCount = 0;
  let networkErrors = 0;

  const deadline = Date.now() + opts.duration * 1000;
  const startedAt = performance.now();

  async function worker() {
    while (Date.now() < deadline) {
      const action = pickAction(opts.mixWeights);
      actionCounts[action] += 1;

      let result;
      if (action === 'search') {
        const query = queries[Math.floor(Math.random() * queries.length)];
        result = await request(
          `${projectPath}/memories?q=${encodeURIComponent(query)}&page=1&pageSize=10`,
          { token },
        );
      } else if (action === 'list') {
        result = await request(`${projectPath}/memories?page=1&pageSize=20`, { token });
      } else {
        result = await request(`${projectPath}/overview`, { token });
      }

      total += 1;
      latencies.push(result.ms);
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);

      if (result.status === 0) {
        networkErrors += 1;
        errorCount += 1;
      } else if (result.status < 200 || result.status >= 400) {
        errorCount += 1;
      }

      if ((result.status === 0 || result.status >= 400) && errors.length < 5) {
        errors.push({
          status: result.status,
          action,
          message: result.error ?? result.json?.error?.message ?? result.text.slice(0, 160),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  // 让最后一批响应有机会计入
  await sleepSafe(50);

  const elapsedSec = (performance.now() - startedAt) / 1000;
  if (total === 0) fail('在指定时长内没有发出任何请求', 1);

  const sorted = latencies.slice().sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  };
  const round = (value) => Math.round(value * 10) / 10;
  const p50 = round(percentile(50));
  const p95 = round(percentile(95));
  const p99 = round(percentile(99));
  const errorRate = errorCount / total;
  const rps = total / elapsedSec;

  const statusRows = [...statuses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, count]) => `${status === 0 ? '网络错误' : status} × ${count}`)
    .join('   ');

  const metricRows = [
    ['请求总数', String(total)],
    ['成功 / 错误', `${total - errorCount} / ${errorCount}（含网络错误 ${networkErrors}）`],
    ['错误率', `${(errorRate * 100).toFixed(2)}%`],
    ['吞吐 RPS', rps.toFixed(1)],
    ['延迟 p50', `${p50} ms`],
    ['延迟 p95', `${p95} ms`],
    ['延迟 p99', `${p99} ms`],
    ['实际耗时', `${elapsedSec.toFixed(2)} s`],
    ['请求构成', `搜索 ${actionCounts.search} / 列表 ${actionCounts.list} / 概览 ${actionCounts.overview}`],
    ['状态码分布', statusRows || '-'],
  ];
  const width = Math.max(...metricRows.map(([label]) => [...label].reduce((n, ch) => n + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0)));

  console.log('');
  console.log('─'.repeat(64));
  for (const [label, value] of metricRows) {
    console.log(`  ${padEndDisplay(label, width)}  ${value}`);
  }
  console.log('─'.repeat(64));

  if (errors.length > 0) {
    console.log('\n错误样例：');
    for (const item of errors) {
      console.log(`  [${item.status || 'ERR'}] ${item.action}：${item.message}`);
    }
  }

  const failures = [];
  if (p95 > opts.maxP95) failures.push(`p95 ${p95}ms 超过阈值 ${opts.maxP95}ms`);
  if (errorRate > opts.maxErrorRate) {
    failures.push(`错误率 ${(errorRate * 100).toFixed(2)}% 超过阈值 ${(opts.maxErrorRate * 100).toFixed(2)}%`);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`✗ 未通过：${failures.join('；')}`);
    process.exit(1);
  }
  console.log('✓ 通过：p95 与错误率均在阈值内');
}

main().catch((error) => {
  console.error(`\n✗ 压测脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
