/**
 * v6 人列表性能计时：对运行中的服务测 persons 列表 / q 搜索 / stats / 人详情 / 记忆列表。
 *
 * 用法：
 *   MNEMOS_PERF_KEY=mnemos_live_xxx node scripts/perf-persons.ts \
 *     --base-url=http://127.0.0.1:4380 --partition=scale --iterations=20
 *
 * 输出 JSON：每个场景的 p50 / p95 / max / 平均耗时与错误数，以及契约预算是否达标。
 * 不会打印 API Key。
 */

import { percentile, round } from '../server/src/http/respond.ts';

interface Options {
  baseUrl: string;
  key: string;
  partition: string;
  iterations: number;
  limit: number;
  q: string;
  memoryLimit: number;
  /** 指定人 ref（internal id 或 external id）；缺省取列表第一条 */
  person?: string;
}

interface Sample {
  ms: number;
  status: number;
  ok: boolean;
  count?: number;
  error?: string;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found?.slice(prefix.length);
}

function positiveInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} 必须是正整数`);
  return Math.min(max, Math.trunc(value));
}

function parseOptions(): Options {
  const key = arg('key') ?? process.env.MNEMOS_PERF_KEY ?? '';
  if (!key) throw new Error('缺少 API Key：用 --key=... 或环境变量 MNEMOS_PERF_KEY 传入（org key）');
  return {
    baseUrl: (arg('base-url') ?? 'http://127.0.0.1:4380').replace(/\/+$/, ''),
    key,
    partition: arg('partition') ?? 'scale',
    iterations: positiveInt('iterations', 20, 200),
    limit: positiveInt('limit', 50, 200),
    q: arg('q') ?? 'user_',
    memoryLimit: positiveInt('memory-limit', 50, 200),
    person: arg('person'),
  };
}

function summarize(samples: Sample[]): Record<string, unknown> {
  const latencies = samples.filter((sample) => sample.ok).map((sample) => sample.ms);
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    samples: samples.length,
    errors,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: Math.max(0, ...latencies),
    avgMs: latencies.length > 0 ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length, 1) : 0,
    rows:
      samples.find((sample) => typeof sample.count === 'number')?.count ??
      samples.reduce((max, sample) => Math.max(max, sample.count ?? 0), 0),
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const headers = {
    authorization: `Bearer ${options.key}`,
    accept: 'application/json',
  };
  const partitionPath = `${options.baseUrl}/v1/partitions/${encodeURIComponent(options.partition)}`;

  async function hit(path: string, method = 'GET', body?: unknown): Promise<Sample> {
    const started = performance.now();
    try {
      const response = await fetch(`${partitionPath}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        payload = null;
      }
      const count =
        Array.isArray((payload as { items?: unknown[] })?.items)
          ? ((payload as { items: unknown[] }).items.length)
          : undefined;
      const ok = response.ok;
      return {
        ms: performance.now() - started,
        status: response.status,
        ok,
        count,
        ...(ok ? {} : { error: text.slice(0, 200) }),
      };
    } catch (error) {
      return {
        ms: performance.now() - started,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function measure(label: string, run: () => Promise<Sample>): Promise<Record<string, unknown>> {
    // 2 次预热不计入
    for (let index = 0; index < 2; index += 1) await run();
    const samples: Sample[] = [];
    for (let index = 0; index < options.iterations; index += 1) samples.push(await run());
    return { label, ...summarize(samples), firstError: samples.find((sample) => !sample.ok)?.error };
  }

  const personsPath = `/persons?limit=${options.limit}`;
  const searchPath = `/persons?limit=${options.limit}&q=${encodeURIComponent(options.q)}`;

  const persons = await measure('persons.list', () => hit(personsPath));
  const search = await measure('persons.search', () => hit(searchPath));
  const stats = await measure('stats', () => hit('/stats'));

  // 人详情：优先 --person，其次列表第一条
  const firstItem = options.person
    ? { id: options.person }
    : await (async (): Promise<{ id?: string } | null> => {
        try {
          const response = await fetch(`${partitionPath}${personsPath}`, { headers });
          const payload = (await response.json()) as { items?: Array<{ id?: string }> };
          return payload.items?.[0] ?? null;
        } catch {
          return null;
        }
      })();

  let personDetail: Record<string, unknown>;
  let memories: Record<string, unknown>;
  if (firstItem?.id) {
    personDetail = await measure('person.detail', () => hit(`/persons/${encodeURIComponent(firstItem.id!)}`));
    memories = await measure('person.memories', () =>
      hit(`/persons/${encodeURIComponent(firstItem.id!)}/memories?limit=${options.memoryLimit}`),
    );
  } else {
    personDetail = { label: 'person.detail', skipped: '分区内没有可测量的人' };
    memories = { label: 'person.memories', skipped: '分区内没有可测量的人' };
  }

  const budgets: Record<string, number> = {
    'persons.list': 100,
    'persons.search': 300,
    stats: 10,
    'person.detail': 20,
    'person.memories': 100,
  };
  const scenarios = [persons, search, stats, personDetail, memories];
  const p95 = Object.fromEntries(
    scenarios
      .filter((scenario) => typeof scenario.label === 'string')
      .map((scenario) => [scenario.label as string, scenario.p95Ms ?? null]),
  );
  const pass = Object.fromEntries(
    Object.entries(budgets).map(([label, budget]) => {
      const value = p95[label];
      return [label, typeof value === 'number' ? value <= budget : null];
    }),
  );

  console.log(
    JSON.stringify(
      {
        baseUrl: options.baseUrl,
        partition: options.partition,
        iterations: options.iterations,
        limit: options.limit,
        q: options.q,
        person: options.person ?? null,
        scenarios,
        budgets,
        pass,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(`[perf-persons] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
