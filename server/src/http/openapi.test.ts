import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_VERSION } from '../../../shared/src/constants.ts';
import type { AppContext } from '../contracts.ts';
import { buildOpenApiDocument } from './openapi.ts';

const app = { env: { host: '127.0.0.1', port: 4380 } } as unknown as AppContext;
const document = buildOpenApiDocument(app);

type PathItem = Record<string, unknown>;

const paths = document.paths as Record<string, PathItem>;
const components = document.components as {
  schemas: Record<string, unknown>;
  securitySchemes: Record<string, { type?: string; scheme?: string }>;
};

test('OpenAPI 文档是纯 JSON，可直接序列化', () => {
  assert.equal(document.openapi, '3.1.0');
  const clone = JSON.parse(JSON.stringify(document)) as unknown;
  assert.deepEqual(clone, document);
});

test('info / servers 使用运行环境信息', () => {
  const info = document.info as { title: string; version: string; description?: string };
  assert.equal(info.title, 'Mnemos API');
  assert.equal(info.version, APP_VERSION);
  assert.equal(typeof info.description, 'string');
  const servers = document.servers as { url: string }[];
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.url, 'http://127.0.0.1:4380');
});

test('paths 数量 ≥ 25，且覆盖关键端点', () => {
  const names = Object.keys(paths);
  assert.ok(names.length >= 25, `paths 只有 ${names.length} 个`);
  // v5 中立面
  assert.ok(names.includes('/v1/partitions'), '缺少 /v1/partitions');
  assert.ok(names.includes('/v1/partitions/{partition}'), '缺少分区详情');
  assert.ok(names.includes('/v1/partitions/{partition}/persons'), '缺少分区人列表');
  assert.ok(names.includes('/v1/partitions/{partition}/persons/{person}'), '缺少分区人详情');
  assert.ok(names.includes('/v1/partitions/{partition}/memories'), '缺少分区记忆写/列表');
  assert.ok(names.includes('/v1/partitions/{partition}/memories/search'), '缺少分区记忆检索');
  assert.ok(names.includes('/v1/partitions/{partition}/persons/{person}/brief'), '缺少人级简报');
  assert.ok(names.includes('/v1/partitions/{partition}/persons/{person}/context'), '缺少人级上下文');
  assert.ok(names.includes('/v1/partitions/{partition}/persons/{person}/dream'), '缺少人级做梦状态');
  // 控制台人维度 / org key
  assert.ok(names.includes('/api/projects/{id}/persons'), '缺少控制台人列表');
  assert.ok(names.includes('/api/projects/{id}/persons/{personRef}'), '缺少控制台人详情');
  assert.ok(names.includes('/api/projects/{id}/persons/{personRef}/dream/run'), '缺少人级做梦触发');
  assert.ok(names.includes('/api/org/keys'), '缺少组织级密钥');
  assert.ok(names.includes('/api/org/keys/{keyId}'), '缺少组织级密钥吊销');
  assert.ok(names.includes('/v1/context'), '缺少 /v1/context');
  assert.ok(names.includes('/v1/memories/search'), '缺少 /v1/memories/search');
  assert.ok(names.includes('/v1/memories'), '缺少 /v1/memories');
  assert.ok(names.includes('/v1/tasks/{id}/finish'), '缺少任务结束');
  assert.ok(names.includes('/v1/export') && names.includes('/v1/import'), '缺少导出/导入');
  assert.ok(names.includes('/api/org/users'), '缺少组织成员');
  assert.equal(typeof paths['/v1/context']?.post, 'object');
  assert.equal(typeof paths['/v1/memories/search']?.post, 'object');
});

test('securitySchemes 同时声明 API Key 与会话', () => {
  const schemes = components.securitySchemes;
  assert.deepEqual(Object.keys(schemes).sort(), ['bearerApiKey', 'bearerSession']);
  for (const name of ['bearerApiKey', 'bearerSession']) {
    assert.equal(schemes[name]?.type, 'http');
    assert.equal(schemes[name]?.scheme, 'bearer');
  }
});

test('包含全部领域模型 schema', () => {
  for (const name of [
    'Memory',
    'Agent',
    'Task',
    'Briefing',
    'Error',
    'ApiKey',
    'OrgUser',
    'Person',
    'PersonStats',
    'PersonInput',
    'PersonContext',
    'Partition',
    'MemoryScope',
    'MemoryDreamStatus',
  ]) {
    assert.ok(components.schemas[name], `缺少 schema：${name}`);
  }
  const scope = components.schemas.MemoryScope as { enum?: string[] };
  assert.deepEqual(scope.enum, ['person', 'partition', 'session']);
});

test('Memory schema 覆盖 person / scope / session 中立字段', () => {
  const memory = components.schemas.Memory as { properties?: Record<string, unknown> };
  for (const field of ['personId', 'actorPersonId', 'personExternalId', 'sessionId', 'scope']) {
    assert.ok(memory.properties?.[field], `Memory 缺少字段：${field}`);
  }
  const apiKey = components.schemas.ApiKey as { properties?: Record<string, { enum?: string[] }> };
  assert.deepEqual(apiKey.properties?.kind?.enum, ['project', 'org']);
  assert.ok(apiKey.properties?.orgId, 'ApiKey 缺少 orgId');
});

test('每个操作都带 summary / security / 标准错误响应', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const errorCodes = ['400', '401', '403', '404', '409', '422', '429', '500'];
  let operations = 0;
  for (const [path, item] of Object.entries(paths)) {
    for (const method of methods) {
      const op = item[method] as
        | { summary?: unknown; security?: unknown; responses?: Record<string, unknown>; tags?: unknown }
        | undefined;
      if (!op) continue;
      operations += 1;
      assert.equal(typeof op.summary, 'string', `${method.toUpperCase()} ${path} 缺少 summary`);
      assert.ok(Array.isArray(op.security), `${method.toUpperCase()} ${path} 缺少 security`);
      const responses = op.responses ?? {};
      const success = Object.keys(responses).filter((code) => code.startsWith('2'));
      assert.ok(success.length >= 1, `${method.toUpperCase()} ${path} 缺少成功响应`);
      for (const code of errorCodes) {
        assert.ok(responses[code], `${method.toUpperCase()} ${path} 缺少 ${code} 响应`);
      }
    }
  }
  assert.ok(operations >= 30, `操作数只有 ${operations} 个`);
});

test('写操作声明 Idempotency-Key 请求头', () => {
  const targets: [string, string][] = [
    ['/v1/memories', 'post'],
    ['/v1/tasks', 'post'],
    ['/v1/tasks/{id}/finish', 'post'],
  ];
  for (const [path, method] of targets) {
    const op = paths[path]?.[method] as { parameters?: { name?: string; in?: string }[] } | undefined;
    assert.ok(op?.parameters, `${method} ${path} 缺少 parameters`);
    const header = op.parameters.find((item) => item.in === 'header' && item.name === 'Idempotency-Key');
    assert.ok(header, `${method} ${path} 缺少 Idempotency-Key`);
  }
});
