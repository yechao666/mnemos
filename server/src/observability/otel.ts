/**
 * OpenTelemetry 链路追踪接入。
 *
 * 设计要点：
 *  - 关闭时（MNEMOS_OTEL_ENABLED 非 1）**不加载 SDK**：SDK 相关包全部在
 *    enabled 分支里动态 import，withSpan 直接执行原函数，不产生 span、不发网络请求。
 *  - 初始化失败（端口冲突、依赖缺失、配置非法）只 warn 并降级为 no-op，不影响启动。
 *  - 导出失败由 wrapped exporter 记录日志；请求处理本身不受影响。
 *  - HTTP 入站由 HttpInstrumentation 生成 server span；全局 fetch（undici）由
 *    UndiciInstrumentation 生成 client span，覆盖 Webhook 投递与 LLM 调用。
 */

import { hostname } from 'node:os';
import { SpanStatusCode, trace, type Attributes, type Tracer } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { APP_VERSION } from '../../../shared/src/constants.ts';
import type { Logger } from '../contracts.ts';
import type { Env } from '../env.ts';

/** 健康探针与指标端点不生成 trace，避免抓取流量淹没链路。 */
const IGNORED_PATHS = new Set(['/healthz', '/readyz', '/metrics', '/api/health']);

/** 生产返回句柄；forceFlush 仅测试辅助函数会提供。 */
export interface ObservabilityHandle {
  enabled: boolean;
  shutdown: () => Promise<void>;
  forceFlush?: () => Promise<void>;
}

type ExportCallback = Parameters<SpanExporter['export']>[1];
type ExportCode = Parameters<ExportCallback>[0]['code'];

let activeTracer: Tracer | null = null;
let activeShutdown: (() => Promise<void>) | null = null;

const DISABLED_HANDLE: ObservabilityHandle = {
  enabled: false,
  async shutdown(): Promise<void> {
    /* no-op */
  },
};

function isIgnoredPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] ?? '';
  return IGNORED_PATHS.has(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 包装 OTLP exporter：把批量导出失败转成结构化日志。
 * OTel 默认通过 diag 输出，而 diag 在未配置时不落日志，排障时容易“静默丢 span”。
 */
class LoggingSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter;
  private readonly logger: Logger;

  constructor(inner: SpanExporter, logger: Logger) {
    this.inner = inner;
    this.logger = logger;
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    try {
      this.inner.export(spans, (result) => {
        if (result.error) {
          this.logger.warn('otel.export.failed', {
            spans: spans.length,
            error: errorMessage(result.error),
          });
        }
        resultCallback(result);
      });
    } catch (error) {
      // 同步抛错同样不能影响请求链路：记录后按失败回调，交给 BatchSpanProcessor 丢弃。
      this.logger.warn('otel.export.failed', {
        spans: spans.length,
        error: errorMessage(error),
      });
      resultCallback({ code: 1 as ExportCode, error: error instanceof Error ? error : new Error(errorMessage(error)) });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * 初始化追踪。未启用时返回 no-op；启用但初始化失败时同样降级为 no-op。
 * 生产签名固定为 (env, logger)。
 */
export async function initObservability(env: Env, logger: Logger): Promise<ObservabilityHandle> {
  if (!env.otelEnabled) {
    activeTracer = null;
    activeShutdown = null;
    return DISABLED_HANDLE;
  }

  try {
    const [
      api,
      semconv,
      { NodeSDK },
      { OTLPTraceExporter },
      { HttpInstrumentation },
      { UndiciInstrumentation },
      { ParentBasedSampler, TraceIdRatioBasedSampler },
      { defaultResource, resourceFromAttributes },
    ] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-undici'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/resources'),
    ]);

    const resource = defaultResource().merge(
      resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: env.otelServiceName,
        [semconv.ATTR_SERVICE_VERSION]: APP_VERSION,
        [semconv.ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env.nodeEnv,
        // 兼容旧版语义约定（部分后端仍按 deployment.environment 检索）。
        'deployment.environment': env.nodeEnv,
        'host.name': hostname(),
      }),
    );

    const exporter = new LoggingSpanExporter(new OTLPTraceExporter({ url: env.otelEndpoint, timeoutMillis: 5_000 }), logger);

    const sdk = new NodeSDK({
      resource,
      // 显式关闭自动资源探测（env/process/host 探测器），资源已在上面完整给出，
      // 避免启动时做多余的异步探测。
      autoDetectResources: false,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(env.otelSampleRate) }),
      traceExporter: exporter,
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (request) => isIgnoredPath(request.url),
        }),
        new UndiciInstrumentation(),
      ],
    });

    sdk.start();
    activeTracer = trace.getTracer(env.otelServiceName, APP_VERSION);

    let closed = false;
    const shutdown = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      activeTracer = null;
      activeShutdown = null;
      try {
        // NodeSDK.shutdown() 会 flush 并关闭 BatchSpanProcessor / OTLP exporter。
        await sdk.shutdown();
      } catch (error) {
        logger.warn('otel.shutdown.failed', { error: errorMessage(error) });
      }
    };
    activeShutdown = shutdown;

    logger.info('otel.enabled', {
      endpoint: env.otelEndpoint,
      serviceName: env.otelServiceName,
      sampleRate: env.otelSampleRate,
    });

    return { enabled: true, shutdown };
  } catch (error) {
    activeTracer = null;
    activeShutdown = null;
    logger.warn('otel.init.failed', { error: errorMessage(error) });
    return DISABLED_HANDLE;
  }
}

/**
 * 以给定名称/属性包一层 span。
 * 未启用（activeTracer 为空）时直接执行 fn，零额外开销。
 * fn 抛错时记录 exception 并把 span 标为 ERROR，随后原样抛出。
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = activeTracer;
  if (!tracer) return fn();

  return tracer.startActiveSpan(name, { attributes: attributes as Attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.recordException(String(error));
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** 当前活动 span 的 traceId；未启用或不在 span 上下文时返回 null。 */
export function currentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const traceId = span.spanContext().traceId;
  if (!traceId || /^0+$/.test(traceId)) return null;
  return traceId;
}

/**
 * 测试辅助：用内存 exporter 启动一个真实的 NodeSDK（含上下文管理器），
 * 从而可以验证 withSpan / currentTraceId 的完整行为。
 * 关闭时会恢复此前的 tracer；NodeSDK 注册的全局 provider 会被关闭。
 */
export async function createTracingForTest(
  exporter: SpanExporter,
  options: { serviceName?: string } = {},
): Promise<ObservabilityHandle> {
  const [{ NodeSDK }, { SimpleSpanProcessor, AlwaysOnSampler }, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
  ]);

  const serviceName = options.serviceName ?? 'mnemos-test';
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    autoDetectResources: false,
    sampler: new AlwaysOnSampler(),
    // SimpleSpanProcessor 同步导出，测试无需等待 batch/flush。
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    instrumentations: [],
  });
  sdk.start();
  const tracer = trace.getTracer(serviceName, APP_VERSION);
  const previousTracer = activeTracer;
  const previousShutdown = activeShutdown;
  activeTracer = tracer;

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (activeTracer === tracer) {
      activeTracer = previousTracer;
      activeShutdown = previousShutdown;
    }
    await sdk.shutdown();
  };
  activeShutdown = shutdown;

  return { enabled: true, shutdown };
}

/** 当前是否真的有 tracer 在记录（供诊断/测试）。 */
export function isTracingEnabled(): boolean {
  return activeTracer !== null && activeShutdown !== null;
}
