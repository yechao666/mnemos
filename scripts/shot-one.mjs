#!/usr/bin/env node
/** 单页截图：node scripts/shot-one.mjs <path> <out.png> [baseUrl] [waitMs] */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[4] ?? 'http://127.0.0.1:4380';
const OUT = resolve(process.argv[3] ?? '.screenshots/page.png');
const PATH = process.argv[2] ?? '/';
const WAIT = Number(process.argv[5] ?? 400);
const CDP = 'http://127.0.0.1:9333';

mkdirSync(dirname(OUT), { recursive: true });

const login = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.MNEMOS_CAPTURE_EMAIL ?? 'lin.wei@mnemos.dev',
      password: process.env.MNEMOS_CAPTURE_PASSWORD ?? 'mnemos-demo',
    }),
  })
).json();
if (!login.token) throw new Error('登录失败');

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('没有可用的 Chrome 页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  const handler = pending.get(msg.id);
  if (handler) {
    pending.delete(msg.id);
    if (msg.error) handler.reject(new Error(msg.error.message));
    else handler.resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

function send(method, params = {}, timeoutMs = 15000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('mnemos.session', ${JSON.stringify(login.token)}); } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}${PATH}` });

// 等待骨架屏消失且正文渲染完成
const deadline = Date.now() + 15000;
let stable = 0;
while (Date.now() < deadline) {
  const { result } = await send(
    'Runtime.evaluate',
    {
      expression:
        "JSON.stringify({s: document.querySelectorAll('.skeleton,.spinner-lg,.loading-block').length, t: document.body.innerText.length})",
      returnByValue: true,
    },
    5000,
  ).catch(() => ({ result: { value: '{}' } }));
  try {
    const state = JSON.parse(result.value);
    if (state.s === 0 && state.t > 400) {
      stable += 1;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
  } catch {
    /* 渲染中 */
  }
  await sleep(200);
}
await sleep(WAIT);

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const info = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({href: location.href, title: document.title})',
  returnByValue: true,
});
console.log(`✓ ${OUT} ${info.result.value}`);
process.exit(0);
