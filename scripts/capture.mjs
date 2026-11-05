#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 截取控制台页面（登录态）。
 * 零依赖：Node 内置 fetch / WebSocket。
 *
 * 用法：node scripts/capture.mjs [baseUrl] [outDir]
 * 前提：Mnemos 服务已启动（默认 http://127.0.0.1:4380），且本机安装 Chrome。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4380';
const OUT = resolve(process.argv[3] ?? 'docs/screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = resolve('.chrome-profile/capture');
const VIEWPORT = { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false };

mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const EMAIL = process.env.MNEMOS_CAPTURE_EMAIL ?? 'lin.wei@mnemos.dev';
const PASSWORD = process.env.MNEMOS_CAPTURE_PASSWORD ?? 'mnemos-demo';

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${url}`);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败：HTTP ${res.status} ${await res.text()}`);
  const auth = await res.json();
  const meRes = await fetch(`${BASE}/api/auth/me`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (!meRes.ok) throw new Error(`读取用户信息失败：HTTP ${meRes.status}`);
  const me = await meRes.json();
  return { ...auth, projects: me.projects ?? [] };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const listeners = this.events.get(msg.method) ?? [];
        for (const fn of listeners) fn(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`事件超时：${method}`)), timeoutMs);
      const fn = (params) => {
        clearTimeout(timer);
        this.events.set(method, (this.events.get(method) ?? []).filter((f) => f !== fn));
        resolve(params);
      };
      this.events.set(method, [...(this.events.get(method) ?? []), fn]);
    });
  }

  close() {
    this.ws.close();
  }
}

const SHOTS = [
  { name: '01-login', path: '/login', wait: 300 },
  { name: '02-dashboard', path: '/', wait: 400 },
  { name: '03-projects', path: '/projects', wait: 400 },
  { name: '04-project-overview', path: null, wait: 400 },
  { name: '05-memories', path: null, wait: 400, suffix: '/memories' },
  { name: '06-memories-search', path: null, wait: 500, suffix: '/memories', search: '周报' },
  { name: '07-graph', path: null, wait: 600, suffix: '/graph' },
  { name: '08-playground', path: null, wait: 400, suffix: '/playground' },
  { name: '09-keys', path: null, wait: 400, suffix: '/keys' },
  { name: '10-usage', path: null, wait: 500, suffix: '/usage' },
  { name: '11-audit', path: null, wait: 400, suffix: '/audit' },
  { name: '12-settings', path: null, wait: 400, suffix: '/settings' },
  { name: '13-docs', path: null, wait: 400, suffix: '/docs' },
  { name: '14-team', path: '/team', wait: 400 },
];

async function waitForRender(cdp, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression:
        "JSON.stringify({skeletons: document.querySelectorAll('.skeleton,.spinner-lg,.loading-block').length, text: document.body.innerText.length})",
      returnByValue: true,
    });
    try {
      const state = JSON.parse(result.value);
      if (state.skeletons === 0 && state.text > 400) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        stable = 0;
      }
    } catch {
      /* 页面尚未就绪 */
    }
    await sleep(200);
  }
}

async function main() {
  const auth = await login();
  const preferred = (auth.projects ?? []).find((p) => p.slug === 'aurora-support') ?? auth.projects?.[0];
  const projectId = preferred?.id;
  if (!projectId) throw new Error('演示账号没有可见项目');
  console.log(`登录成功：${auth.user.name}（${auth.projects.length} 个项目），项目 ${projectId}`);

  await waitFor(`${BASE}/api/health`);

  const chromeUp = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!chromeUp) {
    console.log('启动 headless Chrome…');
    spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--window-size=1600,1000',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore' },
    ).unref();
    await waitFor(`http://127.0.0.1:${PORT}/json/version`);
  }

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到可用的 Chrome 页面目标');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);

  // 在每个新文档加载前注入会话令牌，避免与登录页跳转竞态
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('mnemos.session', ${JSON.stringify(auth.token)}); } catch (e) {}`,
  });
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.once('Page.loadEventFired').catch(() => undefined);
  await sleep(900);

  for (const shot of SHOTS) {
    let path = shot.path;
    if (!path) path = `/projects/${projectId}${shot.suffix ?? ''}`;
    if (shot.search) path += `?q=${encodeURIComponent(shot.search)}`;
    const url = `${BASE}${path}`;
    await cdp.send('Page.navigate', { url });
    await cdp.once('Page.loadEventFired', 3000).catch(() => undefined);
    await waitForRender(cdp);
    await sleep(shot.wait ?? 500);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    const file = resolve(OUT, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  ✓ ${shot.name}  ${url}`);
  }

  cdp.close();
  console.log(`\n截图已保存到 ${OUT}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('截图失败：', error.message);
  process.exit(1);
});
