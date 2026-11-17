import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PARTITION_SETTINGS } from '../../../shared/src/constants.ts';
import type { MemoryCategory, MemoryService, PersonType } from '../../../shared/src/types.ts';
import type { Env } from '../env.ts';
import { writeAudit } from '../lib/audit.ts';
import { newApiKeySecret, newId, nowIso } from '../lib/ids.ts';
import { hashPassword } from '../lib/password.ts';

/**
 * v6 演示数据：1 个组织 + 2 个分区（App / 研发）+ 人 + 记忆 + 密钥。
 * 只在空库自动执行（MNEMOS_DEMO≠0）；生产设置 MNEMOS_DEMO=0。
 */

export interface SeedSummary {
  orgId: string;
  partitions: number;
  persons: number;
  memories: number;
  usageEvents: number;
  demoApiKey?: { partitionSlug: string; secret: string };
  orgKey?: { secret: string };
}

const DEMO_PASSWORD = 'Demo123456';

const APP_USERS: Array<{ id: string; name: string; facts: Array<[MemoryCategory, string]> }> = [
  {
    id: 'alice',
    name: 'Alice',
    facts: [
      ['identity', 'Alice 是知物感恩 App 的产品经理，偏好中文沟通。'],
      ['preference', 'Alice 喜欢简洁的周报，重点看关键指标与风险。'],
      ['constraint', 'Alice 不接受在未确认预算前直接采购第三方服务。'],
      ['fact', 'Alice 负责 2026 年 Q1 的「感恩日记」功能改版。'],
    ],
  },
  {
    id: 'bob',
    name: 'Bob',
    facts: [
      ['identity', 'Bob 是后端工程师，负责记忆检索与 SQLite 存储。'],
      ['skill', 'Bob 熟悉 TypeScript、SQLite FTS5 与 Node 原生 API。'],
      ['lesson', 'Bob 在 FTS5 外部内容表上踩过触发器漏写的坑，必须在 UPDATE 时先 delete 再 insert。'],
      ['plan', 'Bob 计划把列表接口全部改成 keyset 游标分页。'],
    ],
  },
  {
    id: 'carol',
    name: 'Carol',
    facts: [
      ['preference', 'Carol 喜欢先看结论再看细节。'],
      ['event', 'Carol 上周反馈 App 首屏加载慢，需要做虚拟滚动。'],
      ['risk', 'Carol 担心百万级人列表若用 COUNT(*) 会拖垮数据库。'],
    ],
  },
  {
    id: 'dave',
    name: 'Dave',
    facts: [
      ['identity', 'Dave 是测试工程师，负责性能与回归。'],
      ['acceptance', 'Dave 要求人列表 p95 < 100ms、搜索 p95 < 300ms。'],
      ['context', 'Dave 的测试环境使用 5 万人的种子数据。'],
    ],
  },
];

const DEV_AGENTS: Array<{ id: string; name: string; facts: Array<[MemoryCategory, string]> }> = [
  {
    id: 'ds-agent',
    name: 'DS Agent',
    facts: [
      ['decision', '代码评审统一用 pnpm typecheck + pnpm test 作为合并门槛。'],
      ['constraint', '不要直接改 web/src 之外共享目录里的历史文档。'],
      ['lesson', 'SQLite 写事务里不要做网络调用，LLM 调用必须放在事务外。'],
    ],
  },
  {
    id: 'sql-agent',
    name: 'SQL Agent',
    facts: [
      ['insight', 'persons 列表用 keyset 游标 + 覆盖索引，可以避免 OFFSET 深翻页。'],
      ['decision', '人列表默认 limit=50、最大 200，不返回 total。'],
      ['fact', 'partition_stats 由触发器维护，列表页直接读它。'],
    ],
  },
  {
    id: 'doc-agent',
    name: 'Doc Agent',
    facts: [
      ['preference', '文档先写契约再写实现，字段命名 snake_case 与 camelCase 分开。'],
      ['lesson', 'v6 是重建而不是叠加，旧领域代码直接删除。'],
    ],
  },
];

const SHARED_DEV: Array<[MemoryCategory, string]> = [
  ['decision', 'v6 只保留 分区 / 人 / 记忆 三个核心概念，旧领域不做兼容。'],
  ['constraint', '记忆必须属于一个人（person_id NOT NULL），共享由 scope=partition 表达。'],
  ['fact', 'v6 使用 data-v6/ 作为数据目录，旧 data/ 不迁移。'],
  ['acceptance', '游标分页、FTS 前缀搜索、触发器计数与隔离性都要有测试覆盖。'],
];

function insertOrgAndUsers(db: DatabaseSync): { orgId: string; userId: string } {
  const at = nowIso();
  const orgId = newId('org');
  const userId = newId('usr');
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    orgId,
    'Mnemos 演示组织',
    'mnemos-demo',
    'enterprise',
    at,
  );
  db.prepare(
    `INSERT INTO users
       (id, org_id, email, name, role, title, avatar_color, password_hash, status, password_changed_at, created_at)
     VALUES (?, ?, ?, ?, 'owner', '平台管理员', 'violet', ?, 'active', ?, ?)`,
  ).run(userId, orgId, 'admin@mnemos.dev', '演示管理员', hashPassword(DEMO_PASSWORD), at, at);
  return { orgId, userId };
}

export async function runSeed(input: {
  db: DatabaseSync;
  engine: MemoryService;
  env: Env;
  log?: (line: string) => void;
}): Promise<SeedSummary> {
  const { db, engine, env } = input;
  const log = input.log ?? (() => undefined);
  const { orgId, userId } = insertOrgAndUsers(db);
  const actor = { type: 'user' as const, id: userId, label: '演示管理员' };

  const appPartition = engine.upsertPartition(
    orgId,
    {
      slug: 'app-zhiwu',
      name: '知物感恩 App',
      description: '消费类 App：人=user_id，记忆默认仅本人可见。',
      settings: { ...DEFAULT_PARTITION_SETTINGS, defaultScope: 'person', briefMaxChars: 800 },
    },
    actor,
  );
  const devPartition = engine.upsertPartition(
    orgId,
    {
      slug: 'mnemos-dev',
      name: 'Mnemos 研发',
      description: '研发协作：人=agent，共享约定与决策，私有记忆归各自 Agent。',
      settings: {
        ...DEFAULT_PARTITION_SETTINGS,
        defaultScope: 'partition',
        briefMaxChars: 1500,
        retentionDays: 365,
      },
    },
    actor,
  );

  let persons = 0;
  let memories = 0;

  for (const user of APP_USERS) {
    const person = engine.upsertPerson(
      appPartition.id,
      { externalId: user.id, type: 'human' as PersonType, displayName: user.name, attributes: { source: 'demo-app' } },
      actor,
    );
    persons += 1;
    for (const [category, content] of user.facts) {
      engine.addMemory({
        partitionId: appPartition.id,
        personId: person.id,
        scope: 'person',
        category,
        content,
        importance: 0.6,
        source: 'import',
        tags: ['demo'],
        actor,
      });
      memories += 1;
    }
  }

  for (const agent of DEV_AGENTS) {
    const person = engine.upsertPerson(
      devPartition.id,
      {
        externalId: agent.id,
        type: 'agent' as PersonType,
        displayName: agent.name,
        attributes: { model: 'deepseek-chat', source: 'demo-dev' },
      },
      actor,
    );
    persons += 1;
    for (const [category, content] of agent.facts) {
      engine.addMemory({
        partitionId: devPartition.id,
        personId: person.id,
        scope: 'partition',
        category,
        content,
        importance: 0.7,
        source: 'import',
        tags: ['demo', 'shared'],
        actor,
      });
      memories += 1;
    }
  }

  // 分区共享约定由「系统人」写入，便于 UI 展示作者
  const systemPerson = engine.upsertPerson(
    devPartition.id,
    { externalId: 'mnemos-team', type: 'service' as PersonType, displayName: 'Mnemos Team' },
    actor,
  );
  persons += 1;
  for (const [category, content] of SHARED_DEV) {
    engine.addMemory({
      partitionId: devPartition.id,
      personId: systemPerson.id,
      scope: 'partition',
      category,
      content,
      importance: 0.9,
      source: 'import',
      tags: ['demo', 'contract'],
      actor,
    });
    memories += 1;
  }

  // 密钥：分区 key + 组织级 key
  const at = nowIso();
  const partitionSecret = newApiKeySecret();
  db.prepare(
    `INSERT INTO api_keys
       (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at, rate_limit_per_min)
     VALUES (?, ?, ?, 'partition', ?, ?, ?, ?, ?, ?, 600)`,
  ).run(
    newId('key'),
    devPartition.id,
    orgId,
    '演示分区 key',
    partitionSecret.prefix,
    partitionSecret.hash,
    JSON.stringify(['memories:read', 'memories:write']),
    userId,
    at,
  );
  const orgSecret = newApiKeySecret();
  db.prepare(
    `INSERT INTO api_keys
       (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at, rate_limit_per_min)
     VALUES (?, NULL, ?, 'org', ?, ?, ?, ?, ?, ?, 600)`,
  ).run(
    newId('key'),
    orgId,
    '演示组织 key',
    orgSecret.prefix,
    orgSecret.hash,
    JSON.stringify(['memories:read', 'memories:write', 'admin']),
    userId,
    at,
  );

  // 几条演示审计
  writeAudit(db, {
    orgId,
    actor,
    action: 'seed.demo',
    resourceType: 'org',
    resourceId: orgId,
    detail: { partitions: 2, persons, memories },
  });

  log(`演示数据完成：分区 2、人 ${persons}、记忆 ${memories}`);

  return {
    orgId,
    partitions: 2,
    persons,
    memories,
    usageEvents: 0,
    demoApiKey: { partitionSlug: devPartition.slug, secret: partitionSecret.secret },
    orgKey: { secret: orgSecret.secret },
  };
}

export { DEMO_PASSWORD };
