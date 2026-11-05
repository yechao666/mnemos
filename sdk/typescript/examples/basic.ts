/**
 * 基础示例：写入记忆 → 构建任务简报 → 混合检索。
 *
 * 运行（仓库根目录）：
 *   node sdk/typescript/examples/basic.ts
 *
 * 环境变量：
 *   MNEMOS_BASE_URL  默认 http://127.0.0.1:4380
 *   MNEMOS_API_KEY   默认使用演示项目 Atlas 的 Key
 */

import { MnemosApiError, MnemosClient } from '../src/index.ts';

const apiKey = process.env.MNEMOS_API_KEY ?? 'mnemos_live_demo_atlas_ci';
const baseUrl = process.env.MNEMOS_BASE_URL ?? 'http://127.0.0.1:4380';

const client = new MnemosClient({ apiKey, baseUrl });

async function main(): Promise<void> {
  console.log(`→ 连接 Mnemos：${baseUrl}`);

  // 1. 写入一条记忆（原文入库，不做事实抽取）
  const added = await client.memories.add({
    messages: [
      {
        role: 'user',
        content: '我负责订单查询服务，评审时希望重点关注分片键与只读副本的一致性。',
      },
    ],
    userId: 'sdk-example-user',
    metadata: { example: 'basic', channel: 'sdk-typescript' },
    infer: false,
  });
  const memory = added.results[0];
  console.log(`✓ 写入成功：${memory?.id ?? '(无 id)'}（${added.took_ms}ms）`);
  if (memory) console.log(`  正文：${memory.content}`);

  // 2. 构建任务简报：取项目背景 + 规范 + 相关经验
  const briefing = await client.context.build({
    query: '订单查询服务 分片键 评审',
    budgetTokens: 800,
  });
  const hitCount = briefing.sections.reduce((sum, section) => sum + section.hits.length, 0);
  console.log(`✓ 简报完成：${briefing.sections.length} 个分区 / ${hitCount} 条命中 / 约 ${briefing.token_estimate} tokens`);
  for (const section of briefing.sections) {
    if (section.hits.length === 0) continue;
    console.log(`  · ${section.title}：${section.hits.length} 条`);
  }

  // 3. 混合检索
  const search = await client.memories.search({
    query: '查询服务评审关注点',
    userId: 'sdk-example-user',
    topK: 3,
    threshold: 0.1,
  });
  console.log(`✓ 检索完成：${search.results.length} 条命中（${search.took_ms}ms，策略 ${String(search.signals?.strategy ?? 'default')}）`);
  for (const hit of search.results) {
    console.log(`  - [${hit.score.toFixed(3)}] ${hit.content}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof MnemosApiError) {
    console.error(`✗ API 错误：HTTP ${error.status} ${error.code} — ${error.message}`);
    if (error.requestId) console.error(`  requestId: ${error.requestId}`);
    if (error.details) console.error(`  details: ${JSON.stringify(error.details)}`);
  } else {
    console.error('✗ 未预期错误：', error);
  }
  process.exitCode = 1;
});
