/**
 * 基础示例（Mnemos v6）：分区 → 人 → 记忆 → 人级简报 / 上下文 / 检索。
 *
 * 运行（仓库根目录）：
 *   node sdk/typescript/examples/basic.ts
 *
 * 环境变量：
 *   MNEMOS_BASE_URL  默认 http://127.0.0.1:4380
 *   MNEMOS_API_KEY   默认使用本地演示 org key；请换成你自己的 mnemos_live_…
 *   MNEMOS_PARTITION 默认 sdk-demo
 */

import { MnemosApiError, MnemosClient } from '../src/index.ts';

const apiKey = process.env.MNEMOS_API_KEY ?? 'mnemos_live_demo_org_key';
const baseUrl = process.env.MNEMOS_BASE_URL ?? 'http://127.0.0.1:4380';
const partitionSlug = process.env.MNEMOS_PARTITION ?? 'sdk-demo';
const personExternalId = 'sdk-example-user';

const client = new MnemosClient({ apiKey, baseUrl });

async function main(): Promise<void> {
  console.log(`→ 连接 Mnemos：${baseUrl}`);

  // 1. 建 / 幂等 upsert 分区（org key + admin）
  const partition = await client.partitions.create({
    slug: partitionSlug,
    name: 'SDK 示例分区',
    description: 'sdk/typescript/examples/basic.ts',
    settings: { defaultScope: 'partition' },
  });
  console.log(`✓ 分区就绪：${partition.slug}（${partition.id}）`);

  // 2. 建档一个人（人不是登录账号；external_id 由调用方定义）
  const person = await client.persons.upsert(partition.slug, personExternalId, {
    type: 'human',
    displayName: '示例用户',
    attributes: { source: 'sdk-example' },
  });
  console.log(`✓ 人已就绪：${person.display_name}（${person.external_id}，记忆 ${person.memory_count} 条）`);

  // 3. 写入一条记忆
  const { memory } = await client.memories.add(partition.slug, person.external_id, {
    text: '示例用户偏好用中文写评审意见，关注分片键与只读副本一致性。',
    scope: 'partition',
    category: 'preference',
    tags: ['示例', '偏好'],
    metadata: { example: 'basic', channel: 'sdk-typescript' },
  });
  console.log(`✓ 写入成功：${memory.id}`);

  // 4. 人级上下文：资料 + 简报 + 相关记忆 + 分区共享知识 + 可注入 prompt
  const context = await client.personContext(partition.slug, person.external_id, {
    query: '评审关注点',
    budgetTokens: 800,
  });
  console.log(
    `✓ 上下文完成：${context.memories.length} 条本人记忆 / ${context.shared.length} 条共享 / 约 ${context.token_estimate} tokens`,
  );
  console.log(context.prompt);

  // 5. 人级简报（force=true 跳过缓存）
  const brief = await client.personBrief(partition.slug, person.external_id, { force: true });
  console.log(`✓ 简报：${brief.count} 条记忆 → ${brief.text.length} 字（${brief.model}）`);

  // 6. 检索
  const search = await client.memories.search(partition.slug, {
    query: '评审',
    personId: person.id,
    topK: 3,
  });
  console.log(`✓ 检索完成：${search.results.length} 条（${search.took_ms}ms）`);
  for (const hit of search.results) console.log(`  - [${hit.category}] ${hit.content}`);

  // 7. 游标分页（下一页）
  const page = await client.persons.list(partition.slug, { limit: 10, sort: 'recent' });
  console.log(`✓ 人列表：本页 ${page.items.length} 人，next_cursor=${page.next_cursor ?? 'null'}`);
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
