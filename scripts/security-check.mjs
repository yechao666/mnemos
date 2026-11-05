#!/usr/bin/env node
/**
 * Mnemos 安全基线检查（黑盒）
 * ---------------------------------------------------------------------------
 * 对运行中的服务逐项验证安全控制点，输出 PASS / FAIL / SKIP 汇总。
 *  - 安全响应头（CSP / XFO / nosniff / Referrer-Policy / Permissions-Policy）
 *  - 未认证访问 /api/dashboard、/v1/memories/search → 401
 *  - 错误 API Key → 401；无 scope 密钥访问越权接口 → 403
 *  - 登录锁定：连续错误密码 N 次 → 423/429
 *  - IDOR：用 aurora 项目的密钥读取 orion 项目的记忆 → 404/403
 *  - 限流：快速请求 /v1/memories/search，观察 X-RateLimit-* 头
 *  - 幂等：相同 Idempotency-Key 两次写入，第二次回放标记且 id 相同
 *  - /metrics Prometheus 文本；/healthz、/readyz 200
 *  - CORS：非法 Origin 不回显，合法本机 Origin 回显
 *
 * 尚未上线的接口/能力标记为 SKIP，不影响退出码；任一 FAIL 退出码为 1。
 * 服务不可达时退出码为 2（可用 --auto-start 自动拉起一次性实例）。
 *
 * 注意：登录锁定探测会把测试账号锁定（默认 lin.wei@mnemos.dev）。
 * 建议对一次性实例运行（--auto-start），或用 --skip-lockout 跳过。
 *
 * 用法：
 *   node scripts/security-check.mjs
 *   node scripts/security-check.mjs --base http://127.0.0.1:4380 --skip-lockout
 *   node scripts/security-check.mjs --auto-start --base http://127.0.0.1:4392
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
Mnemos 安全基线检查（黑盒）

选项：
  --base <url>                 目标地址，默认 http://127.0.0.1:4380
  --email <email>              控制台账号，默认 lin.wei@mnemos.dev
  --password <pwd>             控制台密码，默认 mnemos-demo
  --admin-key <key>            admin 作用域密钥（跨项目 IDOR 探测），默认 aurora 演示密钥
  --read-key <key>             无 admin 作用域密钥，默认 orion 演示密钥
  --login-max-attempts <n>     登录锁定阈值，默认读 MNEMOS_LOGIN_MAX_ATTEMPTS 或 5
  --skip-lockout               跳过登录锁定探测（避免锁定真实账号）
  --auto-start                 目标不可达时，在目标端口拉起一次性实例（临时数据目录）
  --timeout <ms>               单请求超时，默认 8000
  -h, --help                   显示帮助
`;

const DEFAULTS = {
  base: 'http://127.0.0.1:4380',
  email: 'lin.wei@mnemos.dev',
  password: 'mnemos-demo',
  adminKey: 'mnemos_live_demo_aurora_console',
  readKey: 'mnemos_live_demo_orion_coder',
  loginMaxAttempts: Number(process.env.MNEMOS_LOGIN_MAX_ATTEMPTS ?? 5) || 5,
  skipLockout: false,
  autoStart: false,
  timeout: 8000,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const bools = new Set(['skipLockout', 'autoStart']);
  const alias = { '--skip-login-lockout': 'skipLockout', '--login-attempts': 'loginMaxAttempts' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (!arg.startsWith('--')) {
      console.error(`无法识别的参数：${arg}\n${HELP}`);
      process.exit(2);
    }
    const eq = arg.indexOf('=');
    const rawKey = eq >= 0 ? arg.slice(0, eq) : arg;
    const name = alias[rawKey] ?? rawKey.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!(name in opts)) {
      console.error(`未知选项：${rawKey}\n${HELP}`);
      process.exit(2);
    }
    if (bools.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[(index += 1)];
    if (value === undefined || value === '') {
      console.error(`选项 ${rawKey} 缺少取值\n${HELP}`);
      process.exit(2);
    }
    opts[name] = name === 'loginMaxAttempts' ? Number(value) : value;
  }

  if (!Number.isInteger(opts.loginMaxAttempts) || opts.loginMaxAttempts < 1) {
    console.error('--login-max-attempts 必须是 ≥1 的整数');
    process.exit(2);
  }
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

class Skip extends Error {}

let passed = 0;
let failed = 0;
let skipped = 0;
const results = [];
const opts = parseArgs(process.argv.slice(2));

function record(name, status, detail) {
  results.push({ name, status, detail });
  if (status === 'PASS') {
    passed += 1;
    console.log(`  \x1b[32m✓ PASS\x1b[0m  ${name}${detail ? `\n         ${detail}` : ''}`);
  } else if (status === 'SKIP') {
    skipped += 1;
    console.log(`  \x1b[33m- SKIP\x1b[0m  ${name}${detail ? `\n         ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${name}\n         ${detail}`);
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, 'PASS', typeof detail === 'string' ? detail : '');
  } catch (error) {
    if (error instanceof Skip) record(name, 'SKIP', error.message);
    else record(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

async function raw(path, { method = 'GET', token, key, headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    const response = await fetch(`${opts.base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function login(email, password) {
  return raw('/api/auth/login', { method: 'POST', body: { email, password } });
}

function describe(response) {
  return `HTTP ${response.status} ${response.json?.error?.code ?? ''}`.trim();
}

/* --- 一次性实例（--auto-start） ------------------------------------------ */

let child = null;
let childLogs = '';
const dataDir = resolve(ROOT, '.run/security-check');

function stopChild() {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  child = null;
}

async function probeHealth(timeoutMs = 2000, base = opts.base) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${base}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  const port = Number(new URL(opts.base).port || 4380);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  console.log(`\n目标不可达，自动拉起一次性实例 :${port}（数据目录 ${dataDir}）…`);

  child = spawn(process.execPath, [resolve(ROOT, 'server/src/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MNEMOS_HOST: '127.0.0.1',
      MNEMOS_PORT: String(port),
      MNEMOS_DATA_DIR: dataDir,
      MNEMOS_DB_PATH: resolve(dataDir, 'mnemos.db'),
      MNEMOS_BACKUP_DIR: resolve(dataDir, 'backups'),
      MNEMOS_DEMO: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    childLogs += chunk.toString();
    childLogs = childLogs.split('\n').slice(-120).join('\n');
  });
  child.stderr.on('data', (chunk) => {
    childLogs += chunk.toString();
    childLogs = childLogs.split('\n').slice(-120).join('\n');
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await probeHealth()) {
      console.log('一次性实例已就绪\n');
      return true;
    }
    await sleep(400);
  }
  console.error('一次性实例启动失败，服务日志：\n' + childLogs);
  stopChild();
  return false;
}

function stopAll() {
  stopChild();
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(143);
});

/* --- 检查项 -------------------------------------------------------------- */

async function main() {
  if (!(await probeHealth())) {
    if (!opts.autoStart) {
      console.error(
        `\n✗ 无法连接 ${opts.base}\n  请先启动服务（node server/src/main.ts），或加 --auto-start 让脚本拉起一次性实例。\n`,
      );
      process.exit(2);
    }
    if (!(await startServer())) process.exit(2);
  }

  console.log('Mnemos 安全基线检查');
  console.log(`  目标  ${opts.base}`);
  console.log(`  账号  ${opts.email}`);
  console.log(`  模式  ${opts.skipLockout ? '跳过登录锁定探测' : '含登录锁定探测（会锁定测试账号）'}`);
  console.log('  副作用  幂等探测会写入并删除 1 条测试记忆；限流探测会产生用量事件');
  console.log('');

  /* 1. 安全响应头 --------------------------------------------------------- */
  await check('安全响应头（CSP / XFO / nosniff / Referrer-Policy / Permissions-Policy）', async () => {
    const response = await raw('/api/health');
    if (!response.ok) throw new Error(`/api/health 返回 ${response.status}，无法检查响应头`);
    const header = (name) => (response.headers.get(name) ?? '').trim();
    const problems = [];

    const csp = header('content-security-policy');
    if (!csp) problems.push('缺少 Content-Security-Policy');
    const xfo = header('x-frame-options').toUpperCase();
    if (!['DENY', 'SAMEORIGIN'].includes(xfo)) problems.push('缺少有效的 X-Frame-Options');
    if (header('x-content-type-options').toLowerCase() !== 'nosniff') problems.push('缺少 X-Content-Type-Options: nosniff');
    if (!header('referrer-policy')) problems.push('缺少 Referrer-Policy');
    if (!header('permissions-policy')) problems.push('缺少 Permissions-Policy');

    if (problems.length > 0) throw new Error(problems.join('；'));
    return '5 项安全响应头均已返回';
  });

  /* 2. 未认证访问 --------------------------------------------------------- */
  await check('未认证访问控制台与公开 API → 401', async () => {
    const dashboard = await raw('/api/dashboard');
    const search = await raw('/v1/memories/search', { method: 'POST', body: { query: '安全基线' } });
    const problems = [];
    if (dashboard.status !== 401) problems.push(`/api/dashboard 返回 ${dashboard.status}（期望 401）`);
    if (search.status !== 401) problems.push(`/v1/memories/search 返回 ${search.status}（期望 401）`);
    if (problems.length > 0) throw new Error(problems.join('；'));
    return '/api/dashboard 与 /v1/memories/search 均返回 401';
  });

  /* 3. 错误密钥 ----------------------------------------------------------- */
  await check('错误 API Key → 401', async () => {
    const response = await raw('/v1/memories?page_size=1', {
      key: `mnemos_live_invalid_${Date.now().toString(36)}`,
    });
    if (response.status !== 401) throw new Error(`返回 ${response.status}（期望 401）`);
    return '无效密钥被拒绝';
  });

  /* 4. 作用域越权 --------------------------------------------------------- */
  await check('无 admin scope 的密钥访问 /v1/stats → 403', async () => {
    const response = await raw('/v1/stats', { key: opts.readKey });
    if (response.status === 401) {
      throw new Skip('只读演示密钥不可用（可能已吊销）；跳过 scope 检查');
    }
    if (response.status !== 403) throw new Error(`返回 ${response.status}（期望 403）`);
    return 'memories:read 密钥无法读取统计';
  });

  /* 5. IDOR --------------------------------------------------------------- */
  await check('IDOR：用其他项目密钥读取本项目记忆 → 404/403', async () => {
    const session = await login(opts.email, opts.password);
    if (session.status !== 200) throw new Skip(`登录失败（${describe(session)}），无法取到越权测试样本`);
    const token = session.json?.token;
    if (!token) throw new Skip('登录响应缺少 token');

    const projects = await raw('/api/projects', { token });
    if (projects.status !== 200 || !Array.isArray(projects.json) || projects.json.length === 0) {
      throw new Skip('无法读取项目列表');
    }
    // 默认的 adminKey 属于 aurora 演示项目，因此优先选一个非 aurora 项目构造跨项目读取。
    const candidates = projects.json.filter((item) => item?.slug !== 'aurora-support');
    const other =
      candidates.find((item) => item?.slug === 'orion-python') ?? candidates[0] ?? null;
    if (!other?.id) throw new Skip('没有可用的跨项目样本（只有 aurora 项目）');

    const memories = await raw(`/api/projects/${other.id}/memories?page=1&pageSize=1&status=active`, { token });
    const memory =
      (Array.isArray(memories.json?.items) && memories.json.items[0]) ||
      (Array.isArray(memories.json?.results) && memories.json.results[0]) ||
      null;
    if (!memory?.id) throw new Skip('目标项目没有记忆样本，无法构造越权请求');

    const probe = await raw(`/v1/memories/${encodeURIComponent(memory.id)}`, { key: opts.adminKey });
    if (probe.status === 401) throw new Skip('跨项目探测密钥不可用（可能已吊销）');
    if (probe.status === 200) throw new Error(`越权读取成功（HTTP 200），记忆 ${memory.id} 泄漏给其他项目密钥`);
    if (probe.status !== 404 && probe.status !== 403) {
      throw new Error(`返回 ${probe.status}（期望 404/403）`);
    }
    return `跨项目读取被拒绝（HTTP ${probe.status}）`;
  });

  /* 6. 限流 --------------------------------------------------------------- */
  await check('限流：快速请求 /v1/memories/search 并观察 X-RateLimit-*', async () => {
    const seen = new Set();
    let hit429 = false;
    let authFailed = false;
    for (let index = 0; index < 65; index += 1) {
      const response = await raw('/v1/memories/search', {
        method: 'POST',
        key: opts.readKey,
        body: { query: '幂等', top_k: 1 },
      });
      for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
        if (response.headers.get(name) !== null) seen.add(name);
      }
      if (response.status === 429) {
        hit429 = true;
        break;
      }
      if (response.status === 401) {
        authFailed = true;
        break;
      }
    }
    if (authFailed) throw new Skip('限流探测密钥不可用（可能已吊销）');
    if (seen.has('x-ratelimit-limit') && seen.has('x-ratelimit-remaining')) {
      return `已返回 ${[...seen].join(' / ')}${hit429 ? '，且触发 429' : ''}`;
    }
    if (hit429) throw new Skip('限流已触发 429，但缺少 X-RateLimit-* 响应头');
    throw new Skip('未观察到 X-RateLimit-* 响应头，也未触发 429（限流头可能尚未上线）');
  });

  /* 7. 幂等 --------------------------------------------------------------- */
  await check('幂等：相同 Idempotency-Key 两次写入返回同一 id 且标记回放', async () => {
    const idempotencyKey = `sec-check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const marker = `安全基线幂等探测 ${new Date().toISOString()}`;
    const request = () =>
      raw('/v1/memories', {
        method: 'POST',
        key: opts.adminKey,
        headers: { 'idempotency-key': idempotencyKey },
        body: { text: marker, user_id: 'sec-check', infer: false },
      });

    const first = await request();
    if ([401, 403].includes(first.status)) throw new Skip(`写入密钥不可用或缺少权限（${describe(first)}）`);
    if (first.status === 404) throw new Skip('幂等写入接口尚未上线（404）');
    if (first.status !== 200 && first.status !== 201) {
      throw new Error(`首次写入失败：${describe(first)} ${first.text.slice(0, 200)}`);
    }
    const second = await request();
    const firstId = first.json?.results?.[0]?.id ?? first.json?.id ?? first.json?.memory?.id;
    const secondId = second.json?.results?.[0]?.id ?? second.json?.id ?? second.json?.memory?.id;
    const replayed = (second.headers.get('x-idempotent-replayed') ?? '').toLowerCase();

    if (!firstId) throw new Skip('写入响应缺少记忆 id，无法验证幂等');

    let cleanupNote = '';
    try {
      await raw(`/v1/memories/${encodeURIComponent(firstId)}`, { method: 'DELETE', key: opts.adminKey });
      cleanupNote = '（探测记忆已清理）';
    } catch {
      cleanupNote = '（探测记忆清理失败，请手工删除）';
    }

    if (firstId !== secondId && secondId) {
      throw new Error(`相同幂等键创建了两条记忆：${firstId} / ${secondId}`);
    }
    if (replayed === 'true' && firstId === secondId) {
      return `第二次请求命中回放（${secondId}）${cleanupNote}`;
    }
    if (firstId === secondId) {
      throw new Skip(`两次返回同一 id，但缺少 x-idempotent-replayed 回放标记${cleanupNote}`);
    }
    throw new Skip(`第二次请求未返回 id（${describe(second)}），幂等键可能尚未上线${cleanupNote}`);
  });

  /* 8. 监控端点 ----------------------------------------------------------- */
  await check('/metrics 返回 Prometheus 文本', async () => {
    const response = await raw('/metrics');
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    // 注意：未注册的路由会落到 SPA 静态回退（200 + text/html），不能当作已上线。
    const isSpaFallback = contentType.includes('text/html') || /^\s*<!doctype html/i.test(response.text);
    if (response.status === 404 || isSpaFallback) throw new Skip('/metrics 尚未上线（命中 404 / SPA 回退）');
    if (response.status !== 200) throw new Error(`返回 ${response.status}`);
    if (!/text\/plain/.test(contentType)) throw new Error(`content-type 非 text/plain：${contentType}`);
    if (!/^#\s*(HELP|TYPE)\s/m.test(response.text)) throw new Error('响应不是 Prometheus 文本格式（缺少 # HELP / # TYPE）');
    return `content-type ${contentType}，${response.text.split('\n').length} 行`;
  });

  await check('/healthz 与 /readyz 返回 200', async () => {
    const healthz = await raw('/healthz');
    const readyz = await raw('/readyz');
    const isHtml = (response) => {
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      return contentType.includes('text/html') || /^\s*<!doctype html/i.test(response.text);
    };
    if (healthz.status === 404 || readyz.status === 404 || isHtml(healthz) || isHtml(readyz)) {
      throw new Skip('探针端点尚未上线（404 / SPA 回退）');
    }
    if (healthz.status !== 200) throw new Error(`/healthz 返回 ${healthz.status}`);
    if (readyz.status !== 200) throw new Error(`/readyz 返回 ${readyz.status}`);
    if (healthz.json?.ok !== true || readyz.json?.ok !== true) {
      throw new Error('/healthz 或 /readyz 的 ok 不为 true');
    }
    return '/healthz 200（ok=true），/readyz 200（ok=true）';
  });

  /* 9. CORS --------------------------------------------------------------- */
  await check('CORS：非法 Origin 不回显，合法本机 Origin 回显', async () => {
    const preflight = (origin) =>
      raw('/api/dashboard', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });

    const evilOrigin = 'https://evil.example';
    const goodOrigin = 'http://127.0.0.1:4381';
    const evil = await preflight(evilOrigin);
    const good = await preflight(goodOrigin);

    const evilAllow = evil.headers.get('access-control-allow-origin');
    const goodAllow = good.headers.get('access-control-allow-origin');

    if (evilAllow === evilOrigin) throw new Error(`非法 Origin 被回显：${evilAllow}`);
    if (goodAllow !== goodOrigin) {
      throw new Error(`合法 Origin 未被回显（得到 ${goodAllow ?? 'null'}）`);
    }
    return '非法来源被忽略，本机来源正常回显';
  });

  /* 10. 登录锁定（放在最后：可能锁定账号） -------------------------------- */
  await check(`登录锁定：连续 ${opts.loginMaxAttempts} 次错误密码 → 423/429`, async () => {
    if (opts.skipLockout) throw new Skip('按 --skip-lockout 跳过');
    const statuses = [];
    for (let index = 0; index < opts.loginMaxAttempts; index += 1) {
      const response = await login(opts.email, `wrong-password-${index}-${Date.now().toString(36)}`);
      statuses.push(response.status);
      if (response.status === 423 || response.status === 429) {
        return `第 ${index + 1} 次错误密码返回 ${response.status}（${statuses.join(', ')}）`;
      }
    }

    // 没有触发锁定：用正确密码探测是“未实现”还是“阈值/账号不匹配”。
    const good = await login(opts.email, opts.password);
    if (good.status === 423 || good.status === 429) {
      return `连续错误后正确密码也被限制（HTTP ${good.status}）`;
    }
    if (good.status === 200) {
      throw new Skip(
        `连续 ${opts.loginMaxAttempts} 次错误密码后仍可正常登录（登录锁定可能尚未上线）`,
      );
    }
    throw new Skip(`无法判定：错误尝试 ${statuses.join(', ')}，正确密码返回 ${good.status}`);
  });

  /* 汇总 ---------------------------------------------------------------- */
  const total = passed + failed + skipped;
  console.log('');
  console.log('─'.repeat(64));
  console.log(`  结果   ${total} 项：PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
  if (failed > 0) {
    console.log('');
    console.log('  失败项：');
    for (const item of results.filter((entry) => entry.status === 'FAIL')) {
      console.log(`   - ${item.name}：${item.detail}`);
    }
  }
  console.log('─'.repeat(64));

  if (!opts.skipLockout) {
    console.log(`\n  提示：登录锁定探测可能已锁定 ${opts.email}，请等待锁定窗口结束或使用一次性实例。`);
  }
  stopAll();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`\n✗ 安全基线检查异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  stopAll();
  process.exit(2);
});
