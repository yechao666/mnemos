/**
 * OTel 追踪单元测试：关闭时为 no-op，开启时通过 InMemorySpanExporter 验证
 * span 名称、属性与异常状态。不启动真实 exporter，不产生网络请求。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { loadEnv } from '../env.ts';
import type { Logger } from '../contracts.ts';
import {
  createTracingForTest,
  currentTraceId,
  initObservability,
  isTracingEnabled,
  withSpan,
} from './otel.ts';

function silentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

test('otel：关闭时返回 no-op，withSpan 直接执行且不产生 traceId', async () => {
  const env = loadEnv({ nodeEnv: 'test', otelEnabled: false, logLevel: 'error' });
  const handle = await initObservability(env, silentLogger());

  assert.equal(handle.enabled, false);
  assert.equal(isTracingEnabled(), false);
  assert.equal(currentTraceId(), null);

  let calls = 0;
  const value = await withSpan('should.not.exist', { route: '/v1/memories' }, async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.equal(currentTraceId(), null);

  // 异常仍按原样抛出，不被包装吞掉。
  await assert.rejects(
    () =>
      withSpan('should.not.exist.error', {}, async () => {
        throw new Error('原始错误');
      }),
    /原始错误/,
  );

  await handle.shutdown();
  await handle.shutdown(); // 幂等
});

test('otel：withSpan 生成带名称/属性的 span，异常写入 exception 并标记 ERROR', async () => {
  const exporter = new InMemorySpanExporter();
  const handle = await createTracingForTest(exporter, { serviceName: 'mnemos-tracing-test' });
  assert.equal(handle.enabled, true);
  assert.equal(isTracingEnabled(), true);

  try {
    let insideTraceId: string | null = null;
    const value = await withSpan(
      'mnemos.memory.search',
      {
        'mnemos.route': '/v1/memories/search',
        'mnemos.result_count': 3,
        'mnemos.cached': false,
      },
      async () => {
        insideTraceId = currentTraceId();
        return 'result';
      },
    );
    assert.equal(value, 'result');
    assert.match(insideTraceId ?? '', /^[0-9a-f]{32}$/);

    await assert.rejects(
      () =>
        withSpan('mnemos.memory.write', { 'mnemos.route': '/v1/memories' }, async () => {
          throw new Error('数据库不可写');
        }),
      /数据库不可写/,
    );

    await handle.forceFlush?.();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);

    const success = spans.find((span) => span.name === 'mnemos.memory.search');
    assert.ok(success, '应生成 mnemos.memory.search span');
    assert.equal(success.name, 'mnemos.memory.search');
    assert.equal(success.attributes['mnemos.route'], '/v1/memories/search');
    assert.equal(success.attributes['mnemos.result_count'], 3);
    assert.equal(success.attributes['mnemos.cached'], false);
    assert.equal(success.status.code, SpanStatusCode.UNSET);
    assert.match(success.spanContext().traceId, /^[0-9a-f]{32}$/);
    assert.equal(success.spanContext().traceId, insideTraceId);

    const failure = spans.find((span) => span.name === 'mnemos.memory.write');
    assert.ok(failure, '应生成 mnemos.memory.write span');
    assert.equal(failure.attributes['mnemos.route'], '/v1/memories');
    assert.equal(failure.status.code, SpanStatusCode.ERROR);
    assert.equal(failure.status.message, '数据库不可写');

    const exception = failure.events.find((event) => event.name === 'exception');
    assert.ok(exception, '异常应记录为 exception 事件');
    assert.equal(exception.attributes?.['exception.type'], 'Error');
    assert.equal(exception.attributes?.['exception.message'], '数据库不可写');
  } finally {
    await handle.shutdown();
  }

  assert.equal(isTracingEnabled(), false);
});

test('otel：withSpan 未启用时请求异常原样抛出', async () => {
  const env = loadEnv({ nodeEnv: 'test', otelEnabled: false, logLevel: 'error' });
  await initObservability(env, silentLogger());

  const error = new Error('业务异常');
  await assert.rejects(
    () =>
      withSpan('noop', {}, async () => {
        throw error;
      }),
    (caught) => caught === error,
  );
});
