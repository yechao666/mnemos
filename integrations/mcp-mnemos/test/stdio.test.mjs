/**
 * 入口冒烟测试：真实 spawn `src/index.js`，通过 stdio 发 JSON-RPC。
 *
 * 覆盖：进程启动、initialize、tools/list、tools/call（走 fake HTTP）、
 * 通知无响应、stdin 关闭后正常退出。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, '..', 'src', 'index.js');

async function startFake() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      if (req.method === 'POST' && req.url === '/v1/partitions/ws-demo/memories/search') {
        const raw = JSON.stringify({
          hits: [{ id: 'mem_1', content: '命中', score: 0.9, signals: { keyword: 0.8 } }],
          mode: 'hybrid',
          took_ms: 1,
          strategy: 'vector+keyword',
          echo: body,
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
        res.end(raw);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fake 路由缺失' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function createClient(env) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  const stderr = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  return {
    child,
    responses,
    stderr,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async waitForResponse(id, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = responses.find((item) => item.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`等待响应超时 id=${id}；stderr=${stderr.join('')}`);
    },
  };
}

test('stdio 入口：initialize / tools/list / tools/call / 通知 / 退出', async () => {
  const fake = await startFake();
  const client = createClient({
    MNEMOS_BASE_URL: fake.baseUrl,
    MNEMOS_API_KEY: 'mnemos_live_test',
    MNEMOS_PARTITION: 'ws-demo',
    MNEMOS_PERSON: 'dsh-agent',
  });
  try {
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
    });
    const init = await client.waitForResponse(1);
    assert.equal(init.result.serverInfo.name, 'mnemos-mcp');
    assert.equal(init.result.capabilities.tools.listChanged, false);

    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = await client.waitForResponse(2);
    assert.equal(tools.result.tools.length, 7);

    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'mnemos_search', arguments: { query: '命中' } },
    });
    const called = await client.waitForResponse(3);
    assert.equal(called.result.isError, undefined);
    const payload = JSON.parse(called.result.content[0].text);
    assert.equal(payload.hits[0].content, '命中');
    assert.equal(payload.echo.person_external_id, 'dsh-agent');

    // 通知不应产生响应：id=4 之前只有 3 条响应。
    assert.equal(client.responses.length, 3);
  } finally {
    client.child.stdin.end();
    await new Promise((resolve) => {
      if (client.child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        client.child.kill('SIGKILL');
        resolve();
      }, 3000);
      client.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await fake.close();
  }
});
