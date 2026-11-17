/**
 * TypeScript SDK 测试：使用本地 node:http mock server（随机端口）。
 *
 * 运行：node --test sdk/typescript/test/*.test.ts
 * 覆盖：鉴权头、请求体、查询参数、错误映射、幂等键、429/5xx 重试、
 *       Retry-After、超时、非幂等 POST 不重试、导出/导入、webhook（beta）。
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { MnemosApiError, MnemosClient } from '../src/index.ts';

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type MockHandler = (req: CapturedRequest, res: ServerResponse) => void | Promise<void>;

interface MockServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function startMock(handler: MockHandler): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const captured: CapturedRequest = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      void (async () => {
        try {
          await handler(captured, response);
        } catch (error) {
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
          try {
            response.end(JSON.stringify({ error: { code: 'mock_failure', message: String(error) } }));
          } catch {
            /* 客户端可能已断开（超时用例） */
          }
        }
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function clientFor(server: MockServer, overrides: Partial<ConstructorParameters<typeof MnemosClient>[0]> = {}): MnemosClient {
  return new MnemosClient({
    apiKey: 'mnemos_live_demo_atlas_ci',
    baseUrl: server.baseUrl,
    ...overrides,
  });
}

const memoryFixture = {
  id: 'mem_1',
  projectId: 'prj_atlas',
  userId: 'u-1',
  agentId: 'agent-1',
  taskId: null,
  visibility: 'project',
  content: '周野偏好用中文写评审意见。',
  category: 'preference',
  importance: 0.7,
  confidence: 0.9,
  source: 'api',
  status: 'active',
  tags: ['偏好'],
  metadata: { channel: 'test' },
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  accessCount: 2,
};

/* ------------------------------------------------------------------ */
/* 1. 写入：鉴权头 / 请求体 / camelCase 响应归一化                     */
/* ------------------------------------------------------------------ */

test('写入记忆：Bearer 头、snake_case 请求体、响应归一化为 snake_case', async () => {
  const server = await startMock((req, res) => {
    sendJson(res, 200, {
      results: [memoryFixture],
      events: [{ type: 'ADD', memoryId: 'mem_1', content: memoryFixture.content, at: '2026-11-05T10:00:00.000Z' }],
      tookMs: 3,
    });
  });
  try {
    const client = clientFor(server);
    const result = await client.memories.add({
      text: '周野偏好用中文写评审意见。',
      userId: 'u-1',
      agentId: 'agent-1',
      metadata: { channel: 'test' },
      infer: false,
    });

    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.ok(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/memories');
    assert.equal(request.headers.authorization, 'Bearer mnemos_live_demo_atlas_ci');
    assert.match(String(request.headers['content-type']), /application\/json/);
    assert.deepEqual(JSON.parse(request.body), {
      text: '周野偏好用中文写评审意见。',
      user_id: 'u-1',
      agent_id: 'agent-1',
      metadata: { channel: 'test' },
      infer: false,
    });

    assert.equal(result.took_ms, 3);
    assert.equal(result.results[0]?.id, 'mem_1');
    assert.equal(result.results[0]?.content, memoryFixture.content);
    assert.equal(result.results[0]?.memory, memoryFixture.content, 'content 与 memory 互为别名');
    assert.equal(result.results[0]?.user_id, 'u-1');
    assert.equal(result.results[0]?.created_at, memoryFixture.createdAt);
    assert.equal(result.results[0]?.access_count, 2);
    assert.equal(result.events[0]?.memory_id, 'mem_1');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 2. 列表：查询参数拼接                                               */
/* ------------------------------------------------------------------ */

test('列表：查询参数使用 snake_case、跳过 undefined 并正确编码', async () => {
  const server = await startMock((_req, res) => {
    sendJson(res, 200, { results: [memoryFixture], count: 1, page: 2, page_size: 50 });
  });
  try {
    const client = clientFor(server);
    const result = await client.memories.list({
      userId: '用户 1',
      page: 2,
      pageSize: 50,
      visibility: 'project',
    });

    assert.equal(server.requests.length, 1);
    const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
    assert.equal(url.pathname, '/v1/memories');
    assert.equal(url.searchParams.get('user_id'), '用户 1');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('page_size'), '50');
    assert.equal(url.searchParams.get('visibility'), 'project');
    assert.equal(url.searchParams.has('agent_id'), false);

    assert.equal(result.count, 1);
    assert.equal(result.results[0]?.content, memoryFixture.content);
    assert.equal(result.page_size, 50);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 检索：请求体与 filters                                          */
/* ------------------------------------------------------------------ */

test('检索：snake_case 请求体、filters 与命中的 memory/matched_on 归一化', async () => {
  const server = await startMock((_req, res) => {
    sendJson(res, 200, {
      results: [
        {
          ...memoryFixture,
          content: undefined,
          memory: memoryFixture.content,
          score: 0.73,
          signals: { semantic: 0.68, keyword: 0.52, entity: 0.4, recency: 0.81, importance: 0.74 },
          matched_on: ['semantic', 'keyword'],
          entities: ['周野'],
        },
      ],
      total: 1,
      took_ms: 6,
      signals: { strategy: 'hybrid', query_terms: ['评审'] },
    });
  });
  try {
    const client = clientFor(server);
    const result = await client.memories.search({
      query: '评审偏好',
      agentId: 'agent-1',
      taskId: 'task-1',
      topK: 5,
      threshold: 0.2,
      includePrivate: false,
      filters: {
        category: 'preference',
        createdAfter: '2026-01-01T00:00:00.000Z',
        minImportance: 0.3,
        tags: ['偏好'],
      },
    });

    const body = JSON.parse(server.requests[0]?.body ?? '{}');
    assert.deepEqual(body, {
      query: '评审偏好',
      agent_id: 'agent-1',
      task_id: 'task-1',
      top_k: 5,
      threshold: 0.2,
      include_private: false,
      filters: {
        category: 'preference',
        tags: ['偏好'],
        created_after: '2026-01-01T00:00:00.000Z',
        min_importance: 0.3,
      },
    });

    assert.equal(result.results[0]?.content, memoryFixture.content);
    assert.equal(result.results[0]?.score, 0.73);
    assert.deepEqual(result.results[0]?.matched_on, ['semantic', 'keyword']);
    assert.equal(result.results[0]?.signals.keyword, 0.52);
    assert.equal(result.took_ms, 6);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 4. 错误映射                                                        */
/* ------------------------------------------------------------------ */

test('错误映射：status/code/message/details/requestId 与响应头兜底', async () => {
  const server = await startMock((req, res) => {
    if (req.url === '/v1/memories/bad') {
      sendJson(res, 400, {
        error: {
          code: 'validation_error',
          message: '参数不合法',
          details: [{ path: 'query', message: '不能为空' }],
          requestId: 'req_body',
        },
      });
      return;
    }
    sendJson(
      res,
      404,
      { error: { code: 'not_found', message: '记忆不存在' } },
      { 'x-request-id': 'req_header' },
    );
  });
  try {
    const client = clientFor(server);

    await assert.rejects(
      () => client.memories.get('bad'),
      (error: unknown) => {
        assert.ok(error instanceof MnemosApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'validation_error');
        assert.equal(error.message, '参数不合法');
        assert.equal(error.requestId, 'req_body');
        assert.deepEqual(error.details, [{ path: 'query', message: '不能为空' }]);
        return true;
      },
    );

    await assert.rejects(
      () => client.memories.get('missing'),
      (error: unknown) => {
        assert.ok(error instanceof MnemosApiError);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'not_found');
        assert.equal(error.requestId, 'req_header', '错误体缺 requestId 时取 x-request-id');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 5. 幂等键                                                          */
/* ------------------------------------------------------------------ */

test('幂等键：显式传入才发送 Idempotency-Key', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'POST') {
      sendJson(res, 200, { results: [memoryFixture], events: [], tookMs: 1 });
      return;
    }
    sendJson(res, 200, { nodes: [], edges: [] });
  });
  try {
    const client = clientFor(server);

    await client.memories.add({ text: '有幂等键' }, { idempotencyKey: 'idem-key-12345678' });
    await client.memories.add({ text: '无幂等键' });

    assert.equal(server.requests[0]?.headers['idempotency-key'], 'idem-key-12345678');
    assert.equal(server.requests[1]?.headers['idempotency-key'], undefined);

    await client.graph(10);
    assert.equal(server.requests[2]?.headers['idempotency-key'], undefined);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 6. 429 重试 + Retry-After                                          */
/* ------------------------------------------------------------------ */

test('429：按 Retry-After 等待后重试成功', async () => {
  let attempts = 0;
  const server = await startMock((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      sendJson(
        res,
        429,
        { error: { code: 'rate_limited', message: '请求过于频繁', requestId: 'req_429' } },
        { 'retry-after': '1' },
      );
      return;
    }
    sendJson(res, 200, { results: [memoryFixture], count: 1, page: 1, page_size: 20 });
  });
  try {
    const client = clientFor(server, { maxRetries: 2 });
    const startedAt = Date.now();
    const result = await client.memories.list();
    const elapsed = Date.now() - startedAt;

    assert.equal(attempts, 2);
    assert.ok(elapsed >= 900, `应等待 Retry-After ≈1s，实际 ${elapsed}ms`);
    assert.equal(result.results[0]?.id, 'mem_1');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 7. GET 5xx 重试（指数退避）                                        */
/* ------------------------------------------------------------------ */

test('503：GET 指数退避重试，第二次成功', async () => {
  let attempts = 0;
  const server = await startMock((_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      sendJson(res, 503, { error: { code: 'service_unavailable', message: '稍后重试' } });
      return;
    }
    sendJson(res, 200, { metrics: { total_memories: 3 } });
  });
  try {
    const client = clientFor(server, { maxRetries: 1 });
    const startedAt = Date.now();
    const stats = await client.stats();
    const elapsed = Date.now() - startedAt;

    assert.equal(attempts, 2);
    assert.ok(elapsed >= 150, '应至少经历一次指数退避');
    assert.equal(stats.metrics.total_memories, 3);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 8. 非幂等 POST 不重试 / 带幂等键才重试                              */
/* ------------------------------------------------------------------ */

test('非幂等 POST：默认不重试；提供 idempotencyKey 后重试并复用同一个 key', async () => {
  const taskRequests: CapturedRequest[] = [];
  const server = await startMock((req, res) => {
    taskRequests.push(req);
    sendJson(res, 503, { error: { code: 'service_unavailable', message: '稍后重试' } });
  });
  try {
    const client = clientFor(server, { maxRetries: 2 });

    await assert.rejects(
      () => client.tasks.create({ title: '拆分查询服务' }),
      (error: unknown) => {
        assert.ok(error instanceof MnemosApiError);
        assert.equal(error.status, 503);
        return true;
      },
    );
    assert.equal(taskRequests.length, 1, '无幂等键的 POST 不应重试');

    await assert.rejects(
      () => client.tasks.create({ title: '拆分查询服务' }, { idempotencyKey: 'idem-task-0001' }),
      (error: unknown) => {
        assert.ok(error instanceof MnemosApiError);
        assert.equal(error.status, 503);
        return true;
      },
    );
    const retried = taskRequests.slice(1);
    assert.equal(retried.length, 3, '带幂等键应重试到 maxRetries');
    for (const request of retried) {
      assert.equal(request.headers['idempotency-key'], 'idem-task-0001');
    }
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 9. 超时                                                            */
/* ------------------------------------------------------------------ */

test('超时：AbortSignal.timeout 中断请求并抛出 code=timeout', async () => {
  const server = await startMock(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!res.destroyed) {
      sendJson(res, 200, { results: [], count: 0, page: 1, page_size: 20 });
    }
  });
  try {
    const client = clientFor(server, { timeoutMs: 40, maxRetries: 0 });
    await assert.rejects(
      () => client.memories.list(),
      (error: unknown) => {
        assert.ok(error instanceof MnemosApiError);
        assert.equal(error.status, 0);
        assert.equal(error.code, 'timeout');
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 10. 任务结束 / 简报                                                */
/* ------------------------------------------------------------------ */

test('任务结束与简报：snake_case 请求体、嵌套模型归一化', async () => {
  const server = await startMock((req, res) => {
    if (req.url === '/v1/tasks/task-1/finish') {
      sendJson(res, 200, {
        task: {
          id: 'task-1',
          project_id: 'prj_atlas',
          title: '拆分查询服务',
          goal: '完成首期',
          status: 'done',
          owner_agent_id: 'agent-1',
          owner_agent_name: '开发 Agent',
          branch: 'feat/split',
          summary: '完成首期',
          metadata: {},
          created_at: '2026-11-05T09:00:00.000Z',
          started_at: '2026-11-05T09:00:00.000Z',
          ended_at: '2026-11-05T10:00:00.000Z',
          memory_count: 2,
          agent_count: 1,
        },
        memories: [
          {
            id: 'mem_2',
            memory: '查询走只读副本。',
            user_id: null,
            agent_id: 'agent-1',
            visibility: 'project',
            category: 'fact',
            importance: 0.8,
            confidence: 0.9,
            source: 'agent',
            status: 'active',
            tags: [],
            metadata: {},
            created_at: '2026-11-05T10:00:00.000Z',
            updated_at: '2026-11-05T10:00:00.000Z',
            access_count: 0,
          },
        ],
      });
      return;
    }
    sendJson(res, 200, {
      project: { id: 'prj_atlas', name: 'Atlas', description: '研发助手' },
      agent: null,
      task: null,
      sections: [
        { key: 'project', title: '项目背景', description: '项目描述', hits: [] },
      ],
      prompt: '# 项目背景\n',
      tokenEstimate: 128,
      citations: ['mem_2'],
      builtAt: '2026-11-05T10:00:00.000Z',
      tookMs: 12,
      brief: { text: '最近约定：查询走只读副本。', maxChars: 500, count: 3 },
    });
  });
  try {
    const client = clientFor(server);

    const finished = await client.tasks.finish(
      'task-1',
      { summary: '完成首期', decisions: ['查询走只读副本'], agentId: 'agent-1' },
      { idempotencyKey: 'idem-finish-0001' },
    );
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? '{}'), {
      summary: '完成首期',
      decisions: ['查询走只读副本'],
      agent_id: 'agent-1',
    });
    assert.equal(finished.task.status, 'done');
    assert.equal(finished.task.memory_count, 2);
    assert.equal(finished.memories[0]?.content, '查询走只读副本。');

    const briefing = await client.context.build({ agentId: 'agent-1', taskId: 'task-1', budgetTokens: 500 });
    assert.deepEqual(JSON.parse(server.requests[1]?.body ?? '{}'), {
      agent_id: 'agent-1',
      task_id: 'task-1',
      budget_tokens: 500,
    });
    assert.equal(briefing.token_estimate, 128);
    assert.equal(briefing.built_at, '2026-11-05T10:00:00.000Z');
    assert.equal(briefing.sections[0]?.key, 'project');
    assert.equal(briefing.agent, null);
    assert.equal(briefing.brief?.max_chars, 500);
    assert.equal(briefing.brief?.count, 3);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 11. 导出 / 导入                                                    */
/* ------------------------------------------------------------------ */

test('导出归一化后可直接回灌 import（自动转回 camelCase 导入格式）', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/export') {
      sendJson(res, 200, {
        format: 'mnemos-export/v1',
        exportedAt: '2026-11-05T10:00:00.000Z',
        project: { id: 'prj_atlas', slug: 'atlas-copilot', name: 'Atlas' },
        agents: [],
        tasks: [],
        memories: [memoryFixture],
      });
      return;
    }
    sendJson(res, 200, { imported: 1, skipped: 0, failed: 0, errors: [] });
  });
  try {
    const client = clientFor(server);
    const document = await client.export();
    assert.equal(document.exported_at, '2026-11-05T10:00:00.000Z');
    assert.equal(document.memories[0]?.content, memoryFixture.content);

    const result = await client.import(document);
    assert.equal(result.imported, 1);
    const importBody = JSON.parse(server.requests[1]?.body ?? '{}');
    assert.equal(importBody.format, 'mnemos-export/v1');
    assert.deepEqual(importBody.memories, [
      {
        content: memoryFixture.content,
        visibility: 'project',
        tags: ['偏好'],
        metadata: { channel: 'test' },
        userId: 'u-1',
        agentId: 'agent-1',
      },
    ]);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 12. webhook（beta）                                                */
/* ------------------------------------------------------------------ */

test('webhook（beta）：列表 / 创建 / 轮换密钥 / 投递 / 重放路径', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/webhooks') {
      sendJson(res, 200, [
          {
            id: 'wh_1',
            project_id: 'prj_atlas',
            name: 'CI 回调',
            url: 'https://ci.example.com/hook',
            event_types: ['memory.created'],
            enabled: true,
            description: '',
            created_by: 'usr_1',
            created_at: '2026-11-05T10:00:00.000Z',
            updated_at: '2026-11-05T10:00:00.000Z',
            last_delivery_at: null,
            last_status: null,
            failure_count: 0,
            disabled_at: null,
          },
      ]);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/webhooks') {
      sendJson(res, 200, {
        id: 'wh_2',
        project_id: 'prj_atlas',
        name: '新回调',
        url: 'https://example.com/hook',
        secret: 'whsec_abc',
        event_types: ['memory.created'],
        enabled: true,
        description: '',
        created_by: null,
        created_at: '2026-11-05T10:00:00.000Z',
        updated_at: '2026-11-05T10:00:00.000Z',
        last_delivery_at: null,
        last_status: null,
        failure_count: 0,
        disabled_at: null,
      });
      return;
    }
    if (req.url === '/v1/webhooks/wh_2/rotate-secret') {
      sendJson(res, 200, {
        id: 'wh_2',
        project_id: 'prj_atlas',
        name: '新回调',
        url: 'https://example.com/hook',
        secret: 'whsec_rotated',
        event_types: ['memory.created'],
        enabled: true,
        description: '',
        created_by: null,
        created_at: '2026-11-05T10:00:00.000Z',
        updated_at: '2026-11-05T11:00:00.000Z',
        last_delivery_at: null,
        last_status: null,
        failure_count: 0,
        disabled_at: null,
      });
      return;
    }
    if (req.url === '/v1/webhooks/wh_2/deliveries?page=1&page_size=5&status=failed') {
      sendJson(res, 200, {
        items: [
          {
            id: 'del_1',
            webhook_id: 'wh_2',
            project_id: 'prj_atlas',
            event_type: 'memory.created',
            event_id: 'evt_1',
            status: 'failed',
            attempts: 3,
            max_attempts: 6,
            next_attempt_at: null,
            response_status: 500,
            response_body: 'boom',
            latency_ms: 120,
            error: 'HTTP 500',
            created_at: '2026-11-05T10:00:00.000Z',
            delivered_at: null,
          },
        ],
        page: 1,
        page_size: 5,
        total: 1,
        total_pages: 1,
      });
      return;
    }
    if (req.url === '/v1/webhook-deliveries/del_1/replay') {
      sendJson(res, 200, {
        id: 'del_1',
        webhook_id: 'wh_2',
        project_id: 'prj_atlas',
        event_type: 'memory.created',
        event_id: 'evt_1',
        status: 'pending',
        attempts: 0,
        max_attempts: 6,
        next_attempt_at: null,
        response_status: null,
        response_body: null,
        latency_ms: null,
        error: null,
        created_at: '2026-11-05T10:00:00.000Z',
        delivered_at: null,
      });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: 'mock 未实现' } });
  });
  try {
    const client = clientFor(server);

    const list = await client.webhooks.list();
    assert.equal(list.count, 1);
    assert.equal(list.results[0]?.event_types[0], 'memory.created');

    const created = await client.webhooks.create({
      name: '新回调',
      url: 'https://example.com/hook',
      eventTypes: ['memory.created'],
    });
    assert.equal(created.secret, 'whsec_abc');
    assert.deepEqual(JSON.parse(server.requests[1]?.body ?? '{}'), {
      name: '新回调',
      url: 'https://example.com/hook',
      event_types: ['memory.created'],
    });

    const rotated = await client.webhooks.rotateSecret('wh_2');
    assert.equal(rotated.secret, 'whsec_rotated');
    assert.equal(server.requests[2]?.method, 'POST');
    assert.equal(server.requests[2]?.url, '/v1/webhooks/wh_2/rotate-secret');

    const deliveries = await client.webhooks.deliveries('wh_2', { page: 1, pageSize: 5, status: 'failed' });
    assert.equal(deliveries.items[0]?.status, 'failed');
    assert.equal(deliveries.items[0]?.attempts, 3);
    assert.equal(deliveries.items[0]?.max_attempts, 6);
    assert.equal(deliveries.total_pages, 1);

    const replayed = await client.webhooks.replay('del_1');
    assert.equal(replayed.status, 'pending');
    assert.equal(server.requests[4]?.url, '/v1/webhook-deliveries/del_1/replay');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 13. 详情 / 历史 / 反馈与 Agent 注册表                               */
/* ------------------------------------------------------------------ */

test('详情、历史、反馈与 Agent 注册表：嵌套字段归一化', async () => {
  const agentFixture = {
    id: 'agent-1',
    project_id: 'prj_atlas',
    name: '开发 Agent',
    role: 'assistant',
    model: 'deepseek-chat',
    description: '',
    capabilities: ['code-review'],
    status: 'active',
    metadata: {},
    created_at: '2026-06-20T00:00:00.000Z',
    last_active_at: null,
    stats: { memories: 2, private_memories: 1, tasks: 1, last_task_at: null },
  };

  const server = await startMock((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/memories/mem_1') {
      sendJson(res, 200, {
        ...memoryFixture,
        content: undefined,
        memory: memoryFixture.content,
        history: [
          {
            id: 'hist_1',
            memory_id: 'mem_1',
            event: 'UPDATE',
            old_memory: '旧正文',
            new_memory: memoryFixture.content,
            actor: 'api_key:key_1',
            reason: null,
            created_at: '2026-11-05T10:00:00.000Z',
            meta: {},
          },
        ],
        entities: [{ id: 'ent_1', name: '周野', type: 'person', mention_count: 3 }],
        relations: [],
        neighbors: [],
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/memories/mem_1/history') {
      sendJson(res, 200, {
        results: [
          {
            id: 'hist_2',
            memory_id: 'mem_1',
            event: 'ADD',
            old_memory: null,
            new_memory: '初始正文',
            actor: 'system',
            reason: 'seed',
            created_at: '2026-11-04T10:00:00.000Z',
            meta: { channel: 'seed' },
          },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/memories/mem_1/feedback') {
      sendJson(res, 200, { ...memoryFixture, importance: 0.9 });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/agents') {
      sendJson(res, 200, { results: [agentFixture], count: 1 });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/agents') {
      sendJson(res, 200, agentFixture);
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);

    const detail = await client.memories.get('mem_1');
    assert.equal(detail.content, memoryFixture.content);
    assert.equal(detail.history[0]?.old_content, '旧正文');
    assert.equal(detail.history[0]?.new_content, memoryFixture.content);
    assert.equal(detail.entities[0]?.mention_count, 3);

    const history = await client.memories.history('mem_1');
    assert.equal(history.results[0]?.event, 'ADD');
    assert.equal(history.results[0]?.new_content, '初始正文');
    assert.equal(history.results[0]?.reason, 'seed');

    const feedback = await client.memories.feedback('mem_1', { helpful: true, query: '评审' });
    assert.equal(feedback.importance, 0.9);
    assert.deepEqual(JSON.parse(server.requests[2]?.body ?? '{}'), { helpful: true, query: '评审' });

    const agents = await client.agents.list();
    assert.equal(agents.count, 1);
    assert.equal(agents.results[0]?.stats.private_memories, 1);
    assert.deepEqual(agents.results[0]?.capabilities, ['code-review']);

    const created = await client.agents.create({ name: '开发 Agent', capabilities: ['code-review'] });
    assert.equal(created.id, 'agent-1');
    assert.deepEqual(JSON.parse(server.requests[4]?.body ?? '{}'), {
      name: '开发 Agent',
      capabilities: ['code-review'],
    });
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 14. 记忆简报与做梦（控制台 API）                                    */
/* ------------------------------------------------------------------ */

const briefFixture = {
  projectId: 'prj_atlas',
  text: '最近约定：查询走只读副本；支付回调必须带幂等键。',
  maxChars: 500,
  count: 2,
  model: 'mnemos-condense',
  cached: false,
  generatedAt: '2026-11-05T12:00:00.000Z',
  recent: [
    {
      id: 'mem_1',
      content: '查询走只读副本。',
      category: 'fact',
      importance: 0.8,
      updatedAt: '2026-11-05T11:00:00.000Z',
      taskId: 'task-1',
      agentId: 'agent-1',
    },
  ],
};

const dreamRunFixture = {
  id: 'dream_1',
  projectId: 'prj_atlas',
  trigger: 'manual',
  status: 'completed',
  inputCount: 4,
  insightCount: 2,
  summary: '已整理 4 条新记忆，形成 2 条洞见',
  startedAt: '2026-11-05T12:00:00.000Z',
  finishedAt: '2026-11-05T12:00:03.000Z',
};

function dreamStatusFixture() {
  return {
    settings: { enabled: true, intervalMinutes: 1440, lastAt: '2026-11-05T12:00:03.000Z' },
    pendingCount: 4,
    lastRun: dreamRunFixture,
    runs: [dreamRunFixture],
  };
}

test('记忆简报：GET 查询参数、camelCase 响应归一化为 snake_case', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/prj_atlas/memory/brief')) {
      sendJson(res, 200, briefFixture);
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);
    const brief = await client.brief('prj_atlas', {
      force: true,
      agentId: 'agent-coder',
      maxChars: 800,
    });

    const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/projects/prj_atlas/memory/brief');
    assert.equal(url.searchParams.get('force'), 'true');
    assert.equal(url.searchParams.get('agentId'), 'agent-coder');
    assert.equal(url.searchParams.get('maxChars'), '800');
    assert.equal(url.searchParams.has('includePrivate'), false);

    assert.equal(brief.project_id, 'prj_atlas');
    assert.equal(brief.max_chars, 500);
    assert.equal(brief.count, 2);
    assert.equal(brief.model, 'mnemos-condense');
    assert.equal(brief.cached, false);
    assert.equal(brief.generated_at, '2026-11-05T12:00:00.000Z');
    assert.equal(brief.recent[0]?.updated_at, '2026-11-05T11:00:00.000Z');
    assert.equal(brief.recent[0]?.task_id, 'task-1');
    assert.equal(brief.recent[0]?.agent_id, 'agent-1');
  } finally {
    await server.close();
  }
});

test('记忆简报：PATCH 发送 maxChars，返回更新后的 MemoryBrief', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'PATCH') {
      sendJson(res, 200, { ...briefFixture, maxChars: 1200 });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);
    const brief = await client.updateBriefSettings('prj_atlas', 1200);

    assert.equal(server.requests[0]?.method, 'PATCH');
    assert.equal(server.requests[0]?.url, '/api/projects/prj_atlas/memory/brief');
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? '{}'), { maxChars: 1200 });
    assert.equal(brief.max_chars, 1200);
    assert.equal(brief.count, 2);
  } finally {
    await server.close();
  }
});

test('做梦：状态 / 设置 / 手动运行 / 409 正在做梦', async () => {
  let runCalls = 0;
  const server = await startMock((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/api/projects/prj_atlas/memory/dream') {
      sendJson(res, 200, dreamStatusFixture());
      return;
    }
    if (req.method === 'PATCH' && path === '/api/projects/prj_atlas/memory/dream') {
      sendJson(res, 200, {
        ...dreamStatusFixture(),
        settings: { enabled: false, intervalMinutes: 120 },
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/projects/prj_atlas/memory/dream/run') {
      runCalls += 1;
      if (runCalls === 1) {
        sendJson(res, 200, { run: dreamRunFixture, status: dreamStatusFixture() });
        return;
      }
      sendJson(res, 409, { error: { code: 'dream_in_progress', message: '该项目正在做梦' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);

    const status = await client.dream('prj_atlas');
    assert.equal(status.pending_count, 4);
    assert.equal(status.settings.interval_minutes, 1440);
    assert.equal(status.settings.last_at, '2026-11-05T12:00:03.000Z');
    assert.equal(status.last_run?.insight_count, 2);
    assert.equal(status.runs[0]?.trigger, 'manual');

    const updated = await client.updateDreamSettings('prj_atlas', { enabled: false, intervalMinutes: 120 });
    assert.deepEqual(JSON.parse(server.requests[1]?.body ?? '{}'), {
      enabled: false,
      intervalMinutes: 120,
    });
    assert.equal(updated.settings.enabled, false);
    assert.equal(updated.settings.interval_minutes, 120);

    const result = await client.runDream('prj_atlas');
    assert.equal(server.requests[2]?.method, 'POST');
    assert.equal(server.requests[2]?.url, '/api/projects/prj_atlas/memory/dream/run');
    assert.equal(result.run?.id, 'dream_1');
    assert.equal(result.run?.input_count, 4);
    assert.equal(result.run?.finished_at, '2026-11-05T12:00:03.000Z');
    assert.equal(result.status.pending_count, 4);

    // 第二次触发返回 409：SDK 返回 { run: null, status } 并回读状态。
    const busy = await client.runDream('prj_atlas');
    assert.equal(busy.run, null);
    assert.equal(busy.status.pending_count, 4);
    assert.equal(server.requests[4]?.method, 'GET');
    assert.equal(server.requests[4]?.url, '/api/projects/prj_atlas/memory/dream');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 17. 中立记忆服务 v5：分区 / 人 / 人级简报与做梦 / 人级记忆           */
/* ------------------------------------------------------------------ */

const partitionFixture = {
  id: 'prj_ws_demo',
  partition_id: 'prj_ws_demo',
  project_id: 'prj_ws_demo',
  org_id: 'org_yunshu',
  slug: 'ws-demo',
  name: '演示工作区',
  description: 'DSH 工作区',
  status: 'active',
  region: 'cn-shanghai',
  env: 'production',
  created_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-05T10:00:00.000Z',
  archived_at: null,
};

const personFixture = {
  id: 'prs_alice',
  partition_id: 'prj_ws_demo',
  project_id: 'prj_ws_demo',
  external_id: 'alice',
  type: 'human',
  display_name: 'Alice',
  attributes: { tier: 'pro' },
  status: 'active',
  first_seen_at: '2026-10-01T08:00:00.000Z',
  last_seen_at: '2026-11-05T09:00:00.000Z',
  created_at: '2026-10-01T08:00:00.000Z',
  updated_at: '2026-11-05T09:00:00.000Z',
  stats: {
    memories: 3,
    shared_memories: 1,
    sessions: 2,
    last_memory_at: '2026-11-04T12:00:00.000Z',
  },
};

test('分区：create 按 slug 幂等 upsert、get 支持 id/slug（snake_case 请求与归一化）', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/partitions') {
      sendJson(res, 201, { partition: partitionFixture, created: true });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo') {
      sendJson(res, 200, { partition: partitionFixture });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);
    const created = await client.partitions.create({ slug: 'ws-demo', name: '演示工作区', env: 'production' });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? '{}'), {
      slug: 'ws-demo',
      name: '演示工作区',
      env: 'production',
    });
    assert.equal(created.created, true);
    assert.equal(created.partition.id, 'prj_ws_demo');
    assert.equal(created.partition.partition_id, 'prj_ws_demo');
    assert.equal(created.partition.org_id, 'org_yunshu');
    assert.equal(created.partition.slug, 'ws-demo');
    assert.equal(created.partition.archived_at, null);

    const partition = await client.partitions.get('ws-demo');
    assert.equal(server.requests[1]?.url, '/v1/partitions/ws-demo');
    assert.equal(partition.name, '演示工作区');
    assert.equal(partition.project_id, 'prj_ws_demo');
  } finally {
    await server.close();
  }
});

test('人：upsert/list/get/update 走分区路径并归一化 stats', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'PUT' && req.url === '/v1/partitions/ws-demo/persons/alice') {
      sendJson(res, 200, { person: personFixture });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo/persons?type=human&q=ali&page_size=10&sort=recent') {
      sendJson(res, 200, {
        results: [personFixture],
        items: [personFixture],
        count: 1,
        total: 1,
        page: 1,
        page_size: 10,
        total_pages: 1,
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo/persons/alice') {
      sendJson(res, 200, { person: personFixture });
      return;
    }
    if (req.method === 'PATCH' && req.url === '/v1/partitions/ws-demo/persons/alice') {
      sendJson(res, 200, { person: { ...personFixture, display_name: 'Alice Chen' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);

    const upserted = await client.persons.upsert('ws-demo', 'alice', {
      type: 'human',
      displayName: 'Alice',
      attributes: { tier: 'pro' },
    });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? '{}'), {
      type: 'human',
      display_name: 'Alice',
      attributes: { tier: 'pro' },
    });
    assert.equal(upserted.external_id, 'alice');
    assert.equal(upserted.partition_id, 'prj_ws_demo');
    assert.equal(upserted.stats?.memories, 3);
    assert.equal(upserted.stats?.shared_memories, 1);
    assert.equal(upserted.stats?.sessions, 2);
    assert.equal(upserted.stats?.last_memory_at, '2026-11-04T12:00:00.000Z');

    const page = await client.persons.list('ws-demo', { type: 'human', q: 'ali', pageSize: 10, sort: 'recent' });
    assert.equal(page.count, 1);
    assert.equal(page.items[0]?.external_id, 'alice');
    assert.equal(page.total_pages, 1);

    const person = await client.persons.get('ws-demo', 'alice');
    assert.equal(person.display_name, 'Alice');

    const updated = await client.persons.update('ws-demo', 'alice', { displayName: 'Alice Chen' });
    assert.deepEqual(JSON.parse(server.requests[3]?.body ?? '{}'), { display_name: 'Alice Chen' });
    assert.equal(updated.display_name, 'Alice Chen');
  } finally {
    await server.close();
  }
});

test('人级简报 / 上下文 / 做梦：snake_case 字段与 409 回读', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo/persons/alice/brief?force=true&max_chars=800') {
      sendJson(res, 200, {
        project_id: 'prj_ws_demo',
        partition_id: 'prj_ws_demo',
        person_id: 'prs_alice',
        text: '# 人的简报\n- [偏好] Alice 偏好中文',
        max_chars: 800,
        count: 1,
        model: 'mnemos-condense',
        cached: false,
        generated_at: '2026-11-05T10:00:00.000Z',
        recent: [
          {
            id: 'mem_1',
            content: 'Alice 偏好中文',
            category: 'preference',
            importance: 0.7,
            updated_at: '2026-11-05T09:00:00.000Z',
            person_id: 'prs_alice',
            person_external_id: 'alice',
            scope: 'person',
          },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/partitions/ws-demo/persons/alice/context') {
      sendJson(res, 200, {
        person: personFixture,
        brief: {
          project_id: 'prj_ws_demo',
          person_id: 'prs_alice',
          text: '# 人的简报',
          max_chars: 500,
          count: 1,
          model: 'mnemos-condense',
          cached: false,
          generated_at: '2026-11-05T10:00:00.000Z',
          recent: [],
        },
        memories: [memoryFixture],
        shared: [],
        prompt: '# 人的上下文\n- Alice',
        token_estimate: 128,
        citations: ['mem_1'],
        built_at: '2026-11-05T10:00:00.000Z',
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo/persons/alice/dream') {
      sendJson(res, 200, {
        person_id: 'prs_alice',
        settings: { enabled: true, interval_minutes: 1440 },
        pending_count: 2,
        runs: [
          {
            id: 'dream_1',
            project_id: 'prj_ws_demo',
            partition_id: 'prj_ws_demo',
            person_id: 'prs_alice',
            trigger: 'manual',
            status: 'completed',
            input_count: 2,
            insight_count: 1,
            started_at: '2026-11-05T08:00:00.000Z',
            finished_at: '2026-11-05T08:00:01.000Z',
          },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/partitions/ws-demo/persons/alice/dream/run') {
      sendJson(res, 409, { error: { code: 'CONFLICT', message: '该人正在复盘总结，请稍后再试' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);

    const brief = await client.personBrief('ws-demo', 'alice', { force: true, maxChars: 800 });
    assert.equal(brief.person_id, 'prs_alice');
    assert.equal(brief.max_chars, 800);
    assert.equal(brief.recent[0]?.person_id, 'prs_alice');
    assert.equal(brief.recent[0]?.person_external_id, 'alice');
    assert.equal(brief.recent[0]?.scope, 'person');

    const context = await client.personContext('ws-demo', 'alice', { query: '偏好', budgetTokens: 800 });
    assert.equal(server.requests[1]?.url, '/v1/partitions/ws-demo/persons/alice/context');
    assert.deepEqual(JSON.parse(server.requests[1]?.body ?? '{}'), { query: '偏好', budget_tokens: 800 });
    assert.equal(context.person.external_id, 'alice');
    assert.equal(context.memories[0]?.content, memoryFixture.content);
    assert.equal(context.token_estimate, 128);
    assert.equal(context.built_at, '2026-11-05T10:00:00.000Z');

    const status = await client.personDream('ws-demo', 'alice');
    assert.equal(status.person_id, 'prs_alice');
    assert.equal(status.pending_count, 2);
    assert.equal(status.runs[0]?.person_id, 'prs_alice');

    // 正在做梦 → 409，SDK 回读状态并返回 { run: null, status }。
    const busy = await client.personDreamRun('ws-demo', 'alice');
    assert.equal(busy.run, null);
    assert.equal(busy.status.pending_count, 2);
    assert.equal(server.requests.at(-1)?.method, 'GET');
    assert.equal(server.requests.at(-1)?.url, '/v1/partitions/ws-demo/persons/alice/dream');
  } finally {
    await server.close();
  }
});

test('人级记忆：personId/scope/sessionId 序列化、分区路径与详情/更新/删除路由', async () => {
  const server = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/partitions/ws-demo/memories') {
      sendJson(res, 200, {
        results: [memoryFixture],
        events: [{ type: 'ADD', memory_id: 'mem_1', content: memoryFixture.content, at: '2026-11-05T10:00:00.000Z' }],
        extracted: 1,
        merged: 0,
        skipped: 0,
        took_ms: 4,
      });
      return;
    }
    if (
      req.method === 'GET' &&
      req.url ===
        '/v1/partitions/ws-demo/memories?person_id=alice&scope=person&status=active&q=%E7%89%9B%E5%A5%B6&sort=recent&include_private=true&page=1&page_size=5'
    ) {
      sendJson(res, 200, {
        results: [memoryFixture],
        items: [memoryFixture],
        count: 1,
        total: 1,
        page: 1,
        page_size: 5,
        total_pages: 1,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/partitions/ws-demo/memories/search') {
      sendJson(res, 200, {
        results: [{ ...memoryFixture, score: 0.8, signals: {}, matched_on: ['semantic'] }],
        count: 1,
        total: 1,
        took_ms: 5,
        signals: { strategy: 'hybrid' },
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/partitions/ws-demo/memories/mem_1') {
      sendJson(res, 200, { ...memoryFixture, history: [], entities: [], relations: [], neighbors: [] });
      return;
    }
    if (req.method === 'PATCH' && req.url === '/v1/partitions/ws-demo/memories/mem_1') {
      sendJson(res, 200, { ...memoryFixture, content: '更新后的正文' });
      return;
    }
    if (req.method === 'DELETE' && req.url === '/v1/partitions/ws-demo/memories/mem_1') {
      sendJson(res, 200, { message: 'deleted', ok: true });
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: '未实现' } });
  });
  try {
    const client = clientFor(server);

    const added = await client.memories.add({
      partition: 'ws-demo',
      text: 'Alice 对牛奶过敏',
      personId: 'alice',
      scope: 'person',
      sessionId: 'sess_1',
      category: 'constraint',
      tags: ['过敏'],
    });
    assert.equal(server.requests[0]?.url, '/v1/partitions/ws-demo/memories');
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? '{}'), {
      text: 'Alice 对牛奶过敏',
      person_id: 'alice',
      scope: 'person',
      session_id: 'sess_1',
      category: 'constraint',
      tags: ['过敏'],
    });
    assert.equal(added.took_ms, 4);
    assert.equal(added.results[0]?.id, 'mem_1');

    const list = await client.memories.list({
      partition: 'ws-demo',
      personId: 'alice',
      scope: 'person',
      status: 'active',
      q: '牛奶',
      sort: 'recent',
      includePrivate: true,
      page: 1,
      pageSize: 5,
    });
    assert.equal(list.count, 1);
    assert.equal(list.total_pages, 1);
    assert.equal(list.results[0]?.id, 'mem_1');

    const search = await client.memories.search({
      partition: 'ws-demo',
      query: '牛奶',
      personExternalId: 'alice',
      scope: 'person',
      category: 'constraint',
      topK: 5,
    });
    assert.deepEqual(JSON.parse(server.requests[2]?.body ?? '{}'), {
      query: '牛奶',
      person_id: 'alice',
      scope: 'person',
      category: 'constraint',
      top_k: 5,
    });
    assert.equal(search.results[0]?.score, 0.8);

    const detail = await client.memories.get('mem_1', { partition: 'ws-demo' });
    assert.equal(server.requests[3]?.url, '/v1/partitions/ws-demo/memories/mem_1');
    assert.equal(detail.id, 'mem_1');

    const updated = await client.memories.update(
      'mem_1',
      { text: '更新后的正文', category: 'fact', importance: 0.5 },
      { partition: 'ws-demo' },
    );
    assert.equal(server.requests[4]?.method, 'PATCH');
    assert.deepEqual(JSON.parse(server.requests[4]?.body ?? '{}'), {
      text: '更新后的正文',
      content: '更新后的正文',
      category: 'fact',
      importance: 0.5,
    });
    assert.equal(updated.memory?.content, '更新后的正文');

    const removed = await client.memories.delete('mem_1', { partition: 'ws-demo' });
    assert.equal(server.requests[5]?.method, 'DELETE');
    assert.equal(removed.ok, true);
  } finally {
    await server.close();
  }
});

test('人级字段缺少 partition 时抛 TypeError（避免旧端点静默忽略）', async () => {
  const server = await startMock((req, res) => {
    sendJson(res, 200, { results: [], count: 0, page: 1, page_size: 20 });
  });
  try {
    const client = clientFor(server);
    await assert.rejects(() => client.memories.add({ text: 'x', personId: 'alice' }), /partition/);
    await assert.rejects(() => client.memories.add({ text: 'x', category: 'fact' }), /partition/);
    await assert.rejects(() => client.memories.search({ query: 'x', scope: 'person' }), /partition/);
    await assert.rejects(() => client.memories.list({ scope: 'person' }), /partition/);
    assert.equal(server.requests.length, 0, '非中立端点参数不应发出请求');

    // 旧端点仍按原路径工作。
    const legacy = await client.memories.list({ userId: 'u-1' });
    assert.equal(legacy.count, 0);
    assert.equal(server.requests[0]?.url, '/v1/memories?user_id=u-1');
  } finally {
    await server.close();
  }
});
