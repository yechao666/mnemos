import type { Metrics } from '../contracts.ts';

/**
 * 进程内指标注册表：counter / histogram / gauge，输出 Prometheus 文本格式。
 * 标签名与取值做低基数归一化（排序、去空、截断），避免路由/用户输入撑爆序列数。
 */

export const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500] as const;

const LATENCY_METRIC = 'mnemos_http_request_duration_milliseconds';
const REQUESTS_METRIC = 'mnemos_http_requests_total';
const RATE_LIMITED_METRIC = 'mnemos_rate_limited_total';
const AUTH_FAILURES_METRIC = 'mnemos_auth_failures_total';
const SSE_CLIENTS_METRIC = 'mnemos_sse_clients';

/** 常用 camelCase 名称 → Prometheus 命名，便于调用方写简短名称。 */
const NAME_ALIASES: Record<string, string> = {
  sseClients: SSE_CLIENTS_METRIC,
  rateLimitedTotal: RATE_LIMITED_METRIC,
  authFailuresTotal: AUTH_FAILURES_METRIC,
  requestsTotal: REQUESTS_METRIC,
  errorsTotal: 'mnemos_http_errors_total',
};

const HELP: Record<string, string> = {
  [REQUESTS_METRIC]: 'HTTP requests processed, partitioned by method/route/status.',
  [LATENCY_METRIC]: 'HTTP request latency in milliseconds (bucket bounds in ms).',
  [SSE_CLIENTS_METRIC]: 'Currently connected SSE clients.',
  [RATE_LIMITED_METRIC]: 'Requests rejected by rate limiting.',
  [AUTH_FAILURES_METRIC]: 'Failed authentication attempts.',
  'mnemos_build_info': 'Build information; value is always 1.',
  'mnemos_uptime_seconds': 'Process uptime in seconds.',
  'mnemos_timeouts_total': 'Requests aborted by the request timeout guard.',
};

const MAX_LATENCY_SAMPLES = 2_048;
const MAX_LABEL_VALUE_LENGTH = 160;

type MetricType = 'counter' | 'gauge' | 'histogram';

interface SeriesValue {
  labels: Record<string, string>;
  value: number;
}

interface HistogramValue {
  labels: Record<string, string>;
  buckets: number[];
  sum: number;
  count: number;
}

interface MetricEntry {
  type: MetricType;
  help: string;
  values: Map<string, SeriesValue>;
  histograms: Map<string, HistogramValue>;
}

export interface MetricsOptions {
  /** 版本号写入 mnemos_build_info{version="…"}。 */
  version?: string;
  /** 进程启动时间，用于 mnemos_uptime_seconds。 */
  startedAt?: number;
}

function sanitizeMetricName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_:]/g, '_');
  return /^[A-Za-z_:]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function sanitizeLabelName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function normalizeLabels(labels?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!labels) return result;
  for (const [rawKey, rawValue] of Object.entries(labels)) {
    if (rawValue === undefined || rawValue === null) continue;
    const key = sanitizeLabelName(rawKey);
    const value = String(rawValue).replace(/\s+/g, ' ').slice(0, MAX_LABEL_VALUE_LENGTH);
    result[key] = value;
  }
  return result;
}

function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0000');
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Record<string, string>, extra?: Record<string, string>): string {
  const merged = { ...labels, ...extra };
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return '';
  const body = keys.map((key) => `${key}="${escapeLabelValue(merged[key] ?? '')}"`).join(',');
  return `{${body}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** 线性插值百分位（与响应层的口径保持一致）。 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return Math.round(low + (high - low) * weight);
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  const entries = new Map<string, MetricEntry>();
  const latencySamples: number[] = [];

  function resolveName(name: string): string {
    const alias = NAME_ALIASES[name];
    return sanitizeMetricName(alias ?? name);
  }

  function ensure(name: string, type: MetricType): MetricEntry {
    const existing = entries.get(name);
    if (existing) return existing;
    const entry: MetricEntry = {
      type,
      help: HELP[name] ?? `Mnemos ${type} ${name}.`,
      values: new Map<string, SeriesValue>(),
      histograms: new Map<string, HistogramValue>(),
    };
    entries.set(name, entry);
    return entry;
  }

  function addCounter(name: string, labels: Record<string, string>, value: number): void {
    const entry = ensure(name, 'counter');
    const key = seriesKey(labels);
    const current = entry.values.get(key);
    if (current) current.value += value;
    else entry.values.set(key, { labels, value });
  }

  function setGauge(name: string, labels: Record<string, string>, value: number): void {
    const entry = ensure(name, 'gauge');
    entry.values.set(seriesKey(labels), { labels, value });
  }

  function addGauge(name: string, labels: Record<string, string>, delta: number): void {
    const entry = ensure(name, 'gauge');
    const key = seriesKey(labels);
    const current = entry.values.get(key);
    if (current) current.value += delta;
    else entry.values.set(key, { labels, value: delta });
  }

  function observeHistogram(name: string, value: number, labels: Record<string, string>): void {
    const entry = ensure(name, 'histogram');
    const key = seriesKey(labels);
    const current = entry.histograms.get(key);
    const histogram: HistogramValue =
      current ?? { labels, buckets: HISTOGRAM_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
    const sample = Number.isFinite(value) ? Math.max(0, value) : 0;
    let index = HISTOGRAM_BUCKETS_MS.findIndex((bound) => sample <= bound);
    if (index < 0) index = HISTOGRAM_BUCKETS_MS.length;
    if (index < HISTOGRAM_BUCKETS_MS.length) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    histogram.sum += sample;
    histogram.count += 1;
    entry.histograms.set(key, histogram);

    if (name === LATENCY_METRIC) {
      latencySamples.push(sample);
      if (latencySamples.length > MAX_LATENCY_SAMPLES) latencySamples.shift();
    }
  }

  function sumCounter(name: string, predicate?: (labels: Record<string, string>) => boolean): number {
    const entry = entries.get(name);
    if (!entry) return 0;
    let total = 0;
    for (const series of entry.values.values()) {
      if (predicate && !predicate(series.labels)) continue;
      total += series.value;
    }
    return total;
  }

  function gaugeValue(name: string): number {
    const entry = entries.get(name);
    if (!entry) return 0;
    let total = 0;
    for (const series of entry.values.values()) total += series.value;
    return total;
  }

  // 创建时写入 build_info / uptime（uptime 在每次 render 时刷新）。
  if (options.version) setGauge('mnemos_build_info', { version: options.version }, 1);
  if (options.startedAt !== undefined) {
    setGauge('mnemos_uptime_seconds', {}, Math.max(0, Math.floor((Date.now() - options.startedAt) / 1_000)));
  }

  const metrics: Metrics = {
    counter(name, labels, value = 1) {
      addCounter(resolveName(name), normalizeLabels(labels), value);
    },
    histogram(name, value, labels) {
      observeHistogram(resolveName(name), value, normalizeLabels(labels));
    },
    gauge(name, value, labels) {
      setGauge(resolveName(name), normalizeLabels(labels), value);
    },
    incGauge(name, labels, delta = 1) {
      // 兼容 incGauge('sseClients', -1) 的简写：第二参数是数字时直接当作增量。
      const rawLabels = labels as unknown;
      const numericDelta = typeof rawLabels === 'number' ? rawLabels : undefined;
      addGauge(
        resolveName(name),
        numericDelta === undefined ? normalizeLabels(labels) : {},
        numericDelta ?? delta,
      );
    },
    render() {
      if (options.startedAt !== undefined) {
        setGauge('mnemos_uptime_seconds', {}, Math.max(0, Math.floor((Date.now() - options.startedAt) / 1_000)));
      }
      const lines: string[] = [];
      for (const name of [...entries.keys()].sort()) {
        const entry = entries.get(name);
        if (!entry) continue;
        lines.push(`# HELP ${name} ${entry.help}`);
        lines.push(`# TYPE ${name} ${entry.type}`);
        if (entry.type === 'histogram') {
          for (const key of [...entry.histograms.keys()].sort()) {
            const histogram = entry.histograms.get(key);
            if (!histogram) continue;
            let cumulative = 0;
            for (let index = 0; index < HISTOGRAM_BUCKETS_MS.length; index += 1) {
              cumulative += histogram.buckets[index] ?? 0;
              lines.push(
                `${name}_bucket${renderLabels(histogram.labels, { le: String(HISTOGRAM_BUCKETS_MS[index]) })} ${formatNumber(cumulative)}`,
              );
            }
            lines.push(`${name}_bucket${renderLabels(histogram.labels, { le: '+Inf' })} ${formatNumber(histogram.count)}`);
            lines.push(`${name}_sum${renderLabels(histogram.labels)} ${formatNumber(histogram.sum)}`);
            lines.push(`${name}_count${renderLabels(histogram.labels)} ${formatNumber(histogram.count)}`);
          }
          continue;
        }
        for (const key of [...entry.values.keys()].sort()) {
          const series = entry.values.get(key);
          if (!series) continue;
          lines.push(`${name}${renderLabels(series.labels)} ${formatNumber(series.value)}`);
        }
      }
      return lines.length > 0 ? `${lines.join('\n')}\n` : '';
    },
    snapshot() {
      const errorsTotal = sumCounter(REQUESTS_METRIC, (labels) => Number(labels['status'] ?? 0) >= 500);
      return {
        requestsTotal: sumCounter(REQUESTS_METRIC),
        errorsTotal,
        latencyP50Ms: percentile(latencySamples, 0.5),
        latencyP95Ms: percentile(latencySamples, 0.95),
        sseClients: gaugeValue(SSE_CLIENTS_METRIC),
        rateLimitedTotal: sumCounter(RATE_LIMITED_METRIC),
        authFailuresTotal: sumCounter(AUTH_FAILURES_METRIC),
      };
    },
  };

  return metrics;
}
