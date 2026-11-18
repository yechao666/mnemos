# Mnemos v6.1 · 分区 + 人的中立记忆服务

**Mnemos** 是一个可自托管的记忆服务：**以「分区」隔离，以「人」组织**。
它不预设业务形态——消费类 App 的真人用户、研发团队的智能体、后台服务账号都是「人」；
应用只关心「这个人的这条记忆放在哪个分区、给谁看」。

- **只认两个键**：`Partition`（App / 项目 / 租户 / 工作区）+ `Person`（真人 / 智能体 / 服务）。
- **记忆一定属于一个人**（`person_id NOT NULL`）；共享由记忆上的 `scope` 表达，不需要「无人记忆」。
- **v6.1 质量升级**：混合检索（本地 embedding + FTS + 时效/重要度）、记忆演化
  （去重 / 合并 / 取代 / 时序）、画像（facts/profile）、生命周期（merge/archive/export/delete）、
  实体图谱、多模态附件、PII/加密、评测 harness。
- **百万级人列表**：游标分页（keyset）、FTS5 前缀检索、`partition_stats` 反规范化计数、
  控制台虚拟滚动；列表接口**不返回 total、不做 `COUNT(*)`**。
- **单文件 SQLite**：`node:sqlite` 内置，无外部数据库/消息队列；离线可用，配置 LLM 后可选增强。
- **生态齐全**：TypeScript SDK、Python SDK、MCP server、LangChain `BaseStore` 适配器、DSH 插件。

> **版本 6.2.0**（schema v8）。v6 是干净重建：旧领域（Agent 注册表 / 任务 / 任务简报 / 项目记录 /
> 复盘 / Webhooks）已从代码、表、路由与文档中删除，**不兼容 v5 端点**。v5 保留在 `v5` 分支，
> 数据目录也彼此分离（v5 `data/`，v6.1 `data-v6/`）。详见[与 v5 的关系](#与-v5-的关系)。

---

## v6.1 功能总览

| 能力 | 说明 | 入口 |
| --- | --- | --- |
| 混合检索 | 候选 = FTS 300 + 该人最近 200 + 共享最近 200；`score = Σ w·signal`，返回 `hits/signals/mode/strategy` | `POST .../memories/search` |
| 写管线 | 归一化 hash 去重（NOOP）、相似合并（MERGE）、同 `factKey` / `supersedesId` 取代（SUPERSEDE） | 写记忆 body + 响应 `event` |
| 历史 / 反馈 | 每次写/合并/取代/反馈写 `memory_history`；`helpful` 反馈 ±0.05 调 confidence | `GET .../history`、`POST .../feedback` |
| 异步任务 | `memory_jobs`（embed/extract/profile）+ 同进程 worker（1s tick、重试、崩溃恢复） | 自动；`POST /api/ops/jobs/tick` |
| 结构化画像 | `person_facts` 版本化 + `person_profiles` 摘要缓存；`factKey` 自动沉淀 | `GET .../persons/:p/profile`、`.../facts` |
| 生命周期 | 合并（迁移 memories/facts/feedback）、归档、导出（含 facts 历史）、软删/硬删 | `POST .../merge`、`/archive`、`GET .../export`、`DELETE ...` |
| 时序查询 | `valid_from/valid_to`、`as_of` 回看、`include_superseded` | search body |
| 实体图谱 | `extract` 任务写 entities/memory_entities/relations；图/实体 API + 控制台图谱 | `GET .../graph`、`.../entities` |
| 多模态附件 | 写记忆带 `attachments[]`（URL/caption）；详情返回、列表只给 count；caption 参与检索 | 写记忆 body |
| PII / 合规 | `settings.piiRedaction=basic` 脱敏手机/邮箱/身份证/银行卡；`persons.consent`；审计 | settings + person PATCH |
| 隐私规则（v6.2） | 全局 + 分区规则；regex 直接扫描 / prompt LLM 抽取；写入占位符 + 映射表抽离（正文只存 token，reveal 才解密） | `/api/privacy/rules`、`POST /api/privacy/preview`、写记忆 `placeholders` |
| 可选加密 | `MNEMOS_ENCRYPTION_KEY` → 附件 URL AES-256-GCM 加密（不加密正文，保护 FTS） | 环境变量 |
| 幂等写入 | `Idempotency-Key` 24h 回放；不同 body 409 | 写接口请求头 |
| 评测 | 7 场景：改写召回/时效/冲突/隔离/反馈/合并/画像 | `pnpm eval` |

---

## 为什么是「分区 + 人」

| 概念 | 含义 | 例子 |
| --- | --- | --- |
| **Partition（分区）** | 隔离边界：App / 项目 / 租户 / DSH 工作区；分区之间硬隔离 | `zhiwu-app`、`mnemos-dev`、`ws-demo-1a2b3c4d` |
| **Person（人）** | 记忆主体；`external_id` 由调用方定义，与登录账号无关 | App 的 `user_id`、研发 Agent 的 `agent-a`、`service:dream` |
| **Scope（可见范围）** | `person` 仅本人 / `partition` 分区共享 / `session` 仅该会话 | 用户偏好（person）、团队决策（partition）、一次对话（session） |
| **Fact Key（槽位）** | 同一事实的不同版本共享一个 key；新写入自动取代旧事实 | `preference.language`、`identity.job` |

- 「人」不是登录账号：控制台账号（`users`）只用于登录与权限，一个账号可以管理很多「人」。
- 记忆的 `person_id` 是**归属**，`actor_person_id` 是**写入者**（可不同）。
- 消费类 App 把分区 `default_scope` 设为 `person`；协作/研发分区设为 `partition`。
- 事实是**可演化**的：默认检索只返回当前有效版本，历史版本可审计、可 `as_of` 回看。

---

## 两个基准例子

以下命令假设服务在 `http://127.0.0.1:4380`，并使用一把**组织级 API Key**（`kind=org`）：

```bash
BASE=http://127.0.0.1:4380
KEY=mnemos_live_xxx          # org key：可访问 / 创建本组织任意分区
```

> 创建组织 key：控制台 → 任一分区 →「密钥」页 →「组织密钥」（仅组织 owner 可见），
> 或见 [API 文档](docs/api.md#2-鉴权与密钥)。
> 分区 key 只能访问自身分区，适合单个业务后端。

### 例 1：知物感恩 App —— 人 = `user_id`，默认私有

分区 `zhiwu-app`，每个 App 用户是一个 `human`，记忆默认 `scope=person`：

```bash
# 1) 建分区（按 slug 幂等；分区默认 scope 设为 person）
curl -s -X POST "$BASE/v1/partitions" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"slug":"zhiwu-app","name":"知物感恩 App","settings":{"default_scope":"person"}}'

# 2) 建档（按 (type, external_id) 幂等）
curl -s -X PUT "$BASE/v1/partitions/zhiwu-app/persons/user-123" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"human","display_name":"用户 123"}'

# 3) 写一条私有记忆（factKey 让同槽位新值自动取代旧事实）
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: write-user-123-drink" \
  -d '{"text":"用户 123 喜欢黑咖啡，不加糖","category":"preference","importance":0.8,"fact_key":"preference.drink"}'

# 4) 混合检索（hits 带 score/signals；results 为 v6 兼容字段）
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/memories/search" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"咖啡偏好","person_id":"user-123","mode":"hybrid","top_k":5}'

# 5) 人级简报 / 画像
curl -s "$BASE/v1/partitions/zhiwu-app/persons/user-123/brief?max_chars=400" \
  -H "authorization: Bearer $KEY"
curl -s "$BASE/v1/partitions/zhiwu-app/persons/user-123/profile" \
  -H "authorization: Bearer $KEY"
```

人级列表响应（只有一个用户时 `next_cursor` 为 `null`；`partition_stats` 直接给头部统计）：

```json
{
  "items": [
    {
      "id": "prs_fcf4e44b7a4a4461",
      "external_id": "user-123",
      "type": "human",
      "display_name": "用户 123",
      "memory_count": 1,
      "shared_memory_count": 0,
      "consent": {},
      "merged_into": null,
      "last_seen_at": "2026-11-17T16:01:23.768Z"
    }
  ],
  "next_cursor": null,
  "partition_stats": {
    "partition_id": "ptn_d23e18f261fe451b",
    "persons_total": 1,
    "persons_human": 1,
    "persons_agent": 0,
    "persons_service": 0,
    "memories_total": 1,
    "shared_total": 0,
    "sessions_total": 0,
    "updated_at": "2026-11-17T16:01:23.768Z"
  }
}
```

### 例 2：Mnemos 研发 —— 人 = `agent`，共享 + 私有 + 演化

分区 `mnemos`，每个研发智能体是一个 `agent`：架构决策写 `scope=partition`（团队可见），
私有草稿写 `scope=person`（仅自己可见）：

```bash
# 先给智能体 A 建档（v1 的人级写路径要求人已存在）
curl -s -X PUT "$BASE/v1/partitions/mnemos/persons/agent-a" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"agent","display_name":"Agent A"}'

# 智能体 A 写一条分区共享约束（B/C 也能检索到）
curl -s -X POST "$BASE/v1/partitions/mnemos/persons/agent-a/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"所有数据库访问必须经过 repository 层","scope":"partition","category":"constraint"}'

# 智能体 A 的私有草稿：仅 A 可见
curl -s -X POST "$BASE/v1/partitions/mnemos/persons/agent-a/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"草稿：查询服务先读 read replica，再按 order_id 分片","scope":"person"}'

# 检索 + 回到某个时间点看当时有效的事实
curl -s -X POST "$BASE/v1/partitions/mnemos/memories/search" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"repository","scope":"partition","mode":"hybrid","as_of":"2026-11-17T00:00:00.000Z","top_k":5}'

# 人的上下文：资料 + 简报 + 相关记忆 + 分区共享知识，拼成可直接注入的 prompt
curl -s -X POST "$BASE/v1/partitions/mnemos/persons/agent-a/context" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"budget_tokens":800,"include_partition":true}'

# 图谱 / 实体（由异步 extract 任务生成）
curl -s "$BASE/v1/partitions/mnemos/graph?limit=20" -H "authorization: Bearer $KEY"
```

TypeScript SDK 覆写同一套能力（详见 [`sdk/typescript`](sdk/typescript/README.md)）：

```ts
import { MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({ apiKey: process.env.MNEMOS_ORG_KEY! });

await client.partitions.create({ slug: 'zhiwu-app', name: '知物感恩 App', settings: { defaultScope: 'person' } });
await client.persons.upsert('zhiwu-app', 'user-123', { type: 'human', displayName: '用户 123' });

const { memory, event } = await client.memories.add(
  'zhiwu-app',
  'user-123',
  { text: '用户 123 喜欢黑咖啡', scope: 'person', factKey: 'preference.drink' },
  { idempotencyKey: 'write-user-123-drink' },
);

const search = await client.memories.search('zhiwu-app', { query: '咖啡偏好', topK: 5 });
console.log(search.hits.map((hit) => [hit.score, hit.signals.keyword, hit.content]));

const history = await client.memories.history('zhiwu-app', memory.id);
const profile = await client.persons.profile('zhiwu-app', 'user-123');
const page = await client.persons.list('zhiwu-app', { limit: 50 });
const brief = await client.personBrief('zhiwu-app', 'user-123');
const context = await client.personContext('zhiwu-app', 'user-123', { query: '咖啡偏好' });
console.log(event, history, profile.facts, page.items, brief.text, context.prompt);
```

---

## 核心模型

```
Partition（分区：App / 项目 / 租户 / 工作区）
  └── Person（人：human | agent | service | other）
        ├── Memory（person_id NOT NULL；scope = person | partition | session）
        │     ├── 演化：valid_from / valid_to / supersedes / superseded_by / fact_key
        │     ├── 附件：attachments（URL + caption）
        │     └── 历史：memory_history（ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK）
        ├── PersonFact / PersonProfile（结构化画像）
        ├── Session（可选：一次对话 / 任务）
        └── Brief / Dream（人级）
  Partition 级：实体图、共享简报、统计、密钥、用量、审计、异步任务
```

- 人的唯一键是 `(分区, type, external_id)`；同一个 `external_id` 可以分别建 `human` 与 `agent`。
- `scope=session` 的记忆必须带 `session_id`，只在该会话内可见。
- 分区可配置：默认 scope、简报、做梦、保留期、配额、检索模式/权重、去重/合并阈值、PII 脱敏。
- 存储、索引、混合检索、写管线与任务、画像/图/附件/加密见 [架构文档](docs/architecture.md)。

---

## 百万级人列表怎么做的

目标：一个分区 100 万人时，列表、搜索、统计仍然稳定：

| 设计 | 做法 |
| --- | --- |
| 分页 | **keyset 游标**：`WHERE (sort_value,id) < (?,?) ORDER BY ... LIMIT limit+1`；`cursor = base64url(JSON {v,id,s})` |
| 总数 | **不返回 total**；头部统计读 `partition_stats`（单行主键），前端不再单独请求 |
| 搜索 | FTS5 外部内容表 + 前缀匹配（`q*`）；中文退化为子串；`q` 为空走索引排序 |
| 计数 | `persons.memory_count / shared_memory_count / session_count` 由触发器维护，列表直接读 |
| 排序 | `recent/new/name` 各有索引（带/不带 status 过滤），无内存排序 |
| UI | 每页 50 + 自实现窗口化（固定行高 56px，只渲染可视行），滚动到底自动加载 |
| 检索（v6.1） | 候选上限 700（FTS 300 + 人 200 + 共享 200）+ 内存 cosine；不扫全表，不影响人列表执行计划 |
| 批量导入 | 批事务；导入后 `POST /api/partitions/:p/reconcile` 校准计数 |

实测（本机 Apple Silicon / Node 26，10 万人分区，`scripts/perf-persons.ts`，20 轮）：

| 场景 | p95 | 预算 |
| --- | --- | --- |
| `GET persons?limit=50` | 4ms | < 100ms |
| `GET persons?q=user_` | 13ms | < 300ms |
| `GET stats` | 1ms | < 10ms |
| 人详情 | < 1ms | < 20ms |
| 该人记忆列表 | 1ms | < 100ms |

10 万人种子（`scripts/seed-scale.ts`）约 16s。百万级设计、检索候选/延迟预算、压测步骤与容量估算见
[`docs/v6-scale.md`](docs/v6-scale.md)。

---

## 快速开始

要求：**Node.js ≥ 22.18**、pnpm 10.4。

```bash
pnpm install
pnpm seed       # 在 data-v6/ 写入演示数据（2 个分区、8 个人、26 条记忆、演示密钥）
pnpm dev        # 启动 http://127.0.0.1:4380（node --watch）
```

- 控制台地址：<http://127.0.0.1:4380>；登录页提供 **3 个演示账号一键填充**（密码统一 `Demo123456`）：
  - `admin@mnemos.dev`（所有者）、`dev@mnemos.dev`（开发者）、`viewer@mnemos.dev`（只读）。
- 登录页还有 **企业微信 Mock 登录**（仅开发/测试，已有）：点击 → Mock 扫码 → 直接以演示管理员登录。
  由 `MNEMOS_WECOM_MOCK=0/1` 控制（默认跟随 `MNEMOS_DEMO`，生产务必关闭）。
- 演示分区：
  - `app-zhiwu`「知物感恩 App」：4 个 `human`，默认 `scope=person`（消费类 App）；
  - `mnemos-dev`「Mnemos 研发」：3 个 `agent` + 1 个 `service`，记忆 `scope=partition`（研发协作）。
- `pnpm seed` 会打印**演示分区 Key 与 org Key 的明文**（只此一次）；用它们调 `/v1` 接口。
- 控制台静态资源由 `pnpm build` 生成；只跑 API 时可以不构建。前端热更新用 `pnpm dev:web`
  （Vite 4381，代理 `/api`、`/v1` 到 4380）。
- 数据目录默认 `data-v6/`（已 gitignore）；环境变量示例见 [`.env.example`](.env.example)。
  服务端**不会自动加载 `.env`**：需要时用 `node --env-file=.env server/src/main.ts`。

重置演示数据（`--force` 会清空全部演示数据，可重复执行）：

```bash
pnpm seed
```

### 规模数据与压测

```bash
# 生成 10 万人（默认写 data-v6/scale.db）；--persons=1000000 可生成 100 万
pnpm seed:scale

# 自定义路径/人数/记忆密度
node scripts/seed-scale.ts --persons=1000000 --db=/tmp/mnemos-1m.db --memory-every=10

# 对运行中的服务测 5 个场景（需要一把有 memories:read 的 key）
MNEMOS_PERF_KEY=mnemos_live_xxx node scripts/perf-persons.ts \
  --base-url=http://127.0.0.1:4380 --partition=scale --iterations=20 --q=user_
```

### v6.1 运维与评测

```bash
# 7 个记忆质量场景（改写召回/时效/冲突/隔离/反馈/合并/画像）；全通过 exit 0
pnpm eval

# v6 → v7 升级后补齐历史 embedding（幂等，可重复执行）
pnpm backfill:embeddings

# 手工跑一批异步任务（admin 会话）
curl -s -X POST http://127.0.0.1:4380/api/ops/jobs/tick \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"limit":20}'
```

配置 `MNEMOS_ENCRYPTION_KEY` 后附件 URL 加密落库；生产细节见
[`docs/operations.md`](docs/operations.md#7-v61-异步任务回填与评测)。

---

## 控制台

信息架构：**组织 → 分区 → 人 → 记忆**。

| 页面 | 内容 |
| --- | --- |
| 分区列表 | 名称 / slug / 状态 + 人 / 记忆 / 共享计数（读 `partition_stats`）+ 最近活跃 |
| 分区概览 | 统计卡、最近活跃人、最近记忆（游标加载） |
| **人列表**（核心） | FTS 搜索（300ms 防抖）、类型/状态筛选、排序（最近活跃 / 最新建档 / 姓名）、游标分页 + 虚拟滚动、筛选条件写入 URL 可回放 |
| 人详情 | 资料与行内计数、**画像卡（facts 编辑 / 摘要）**、生命周期（合并/归档/导出/删除）、consent、最近记忆、人级简报、做梦 |
| 记忆 | 游标列表 + 人/scope/分类筛选 + 全文搜索；**检索信号分解、历史时间线、反馈按钮、时效徽标、附件**；批量操作仅限当前页 |
| 设置 | 检索模式/权重、embedding、merge/dedupe 阈值、实体抽取、**PII 脱敏**、保留期、配额 |
| 密钥 | 分区 key（创建/轮换/吊销）；组织 key（仅 owner 可见）在同一页 |
| 用量 / 审计 / API 文档 | 分区级用量与审计、控制台内的 API 摘要 |
| 组织设置 | 账号管理、组织级 Key |

控制台不做 `COUNT(*)`、不逐行请求 stats、不一次性加载全量列表；分页协议与 `/v1` 一致
（只是 camelCase）。v6.1 的检索信号、历史/反馈、画像/生命周期已接入控制台；
图谱页由 P2 前端任务收尾（API 已就绪）。

---

## API 摘要

公开 API 在 `/v1/partitions/:partition/...`，snake_case；`:partition` 支持内部 id 或 slug。
完整参数、示例与错误码见 [`docs/api.md`](docs/api.md)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` / `GET` | `/v1/partitions` | 建/幂等 upsert 分区（org key）；分区列表（org key） |
| `GET` / `PATCH` | `/v1/partitions/:p` | 分区信息 / 更新（PATCH 需 `admin`） |
| `GET` | `/v1/partitions/:p/stats` | 分区统计（读 `partition_stats`） |
| `GET` | `/v1/partitions/:p/persons` | 人列表：`cursor/limit/q/type/status/sort/include_merged` |
| `PUT` / `GET` / `PATCH` | `/v1/partitions/:p/persons/:person` | 建档/详情/更新（person = id 或 external_id） |
| `GET` | `.../persons/:person/profile`、`.../facts` | 画像 / 当前 facts |
| `PUT` / `DELETE` | `.../persons/:person/facts[/:factId]` | 写 facts / 软关闭 fact |
| `POST` | `.../persons/:person/merge`、`.../archive` | 合并 / 归档 |
| `GET` / `DELETE` | `.../persons/:person/export`、`.../persons/:person` | 合规导出 / 软删·硬删 |
| `GET` / `POST` | `.../persons/:person/memories` | 该人的记忆列表 / 写记忆（含 attachments / fact_key / supersedes_id） |
| `GET` / `POST` | `.../persons/:person/brief`、`.../context` | 人级简报 / 上下文（可直接注入的 prompt） |
| `GET` / `POST` | `.../persons/:person/dream`、`.../dream/run` | 人级做梦状态 / 手动触发 |
| `GET` / `POST` | `.../memories/search` | 混合检索（`hits`/`signals`/`mode`/`strategy`） |
| `GET` / `POST` | `.../memories/:id/history`、`.../feedback` | 历史时间线 / 检索反馈 |
| `GET` / `PATCH` / `DELETE` | `.../memories/:id` | 记忆详情（含附件）/ 更新 / 删除 |
| `GET` | `.../graph`、`.../entities` | 实体关系图 / 实体列表 |
| `GET` | `/health`、`/healthz`、`/readyz`、`/metrics` | 健康与指标 |

一个游标列表请求：

```bash
curl -s "$BASE/v1/partitions/mnemos-dev/persons?limit=3&sort=recent" \
  -H "authorization: Bearer $KEY"
```

响应（`items` 节选 1 条；`next_cursor` 非空表示还有下一页）：

```json
{
  "items": [
    {
      "id": "prs_099a48a45bc84924",
      "external_id": "mnemos-team",
      "type": "service",
      "display_name": "Mnemos Team",
      "memory_count": 0,
      "shared_memory_count": 4,
      "consent": {},
      "merged_into": null,
      "last_seen_at": "2026-11-17T16:00:44.852Z"
    }
  ],
  "next_cursor": "eyJ2IjoiMjAyNi0xMS0xN1QxNjowMDo0NC44NTBaIiwiaWQiOiJwcnNfOTMyNDE3ZTM1NGZhNGQ3MiIsInMiOiJyZWNlbnQifQ",
  "partition_stats": {
    "partition_id": "ptn_2c3dcb0f511c4c81",
    "persons_total": 4,
    "persons_human": 0,
    "persons_agent": 3,
    "persons_service": 1,
    "memories_total": 12,
    "shared_total": 12,
    "sessions_total": 0,
    "updated_at": "2026-11-17T16:00:44.852Z"
  }
}
```

- `limit` 默认 50、最大 200；`next_cursor` 为 `null` 时没有下一页；**没有 total**。
- 翻下一页：把 `next_cursor` 原样传给 `cursor`；换 `sort` 必须重新从第一页开始。
- 错误体固定 `{ "error": { "code", "message", "requestId" } }`；错误码见 [API 文档](docs/api.md#8-错误码)。

---

## SDK 与生态

| 项目 | 说明 | 文档 |
| --- | --- | --- |
| TypeScript SDK | 零运行时依赖；类型完整覆盖 v6.1（检索信号、历史/反馈、画像/生命周期、图、附件） | [`sdk/typescript`](sdk/typescript/README.md) |
| Python SDK | 零第三方依赖（`urllib`）；persons / memories / search / history / feedback / brief / context / dream | [`sdk/python`](sdk/python/README.md) |
| MCP server | stdio JSON-RPC，工具 `mnemos_search/add/brief/context/person/profile/status`，资源含人画像 | [`integrations/mcp-mnemos`](integrations/mcp-mnemos/README.md) |
| LangChain | `BaseStore` 适配器（namespace → partition/person，key/value 落 metadata；可选依赖） | [`integrations/langchain-mnemos`](integrations/langchain-mnemos/README.md) |
| DSH 插件 | 工作区 = 分区、记忆按人；8 个工具 + 配置页 | [`integrations/dsh-mnemos-personal`](integrations/dsh-mnemos-personal/README.md) |

### Python SDK

```python
from mnemos import MnemosClient

client = MnemosClient(api_key="mnemos_live_…", base_url="http://127.0.0.1:4380")
person = client.persons.upsert("user-1", type="human", display_name="周野")
result = client.memories.add("user-1", text="周野偏好中文评审意见", scope="partition", fact_key="preference.language")
search = client.memories.search("评审偏好", top_k=5)
for hit in search.hits:
    print(hit.score, hit.signals.keyword, hit.content)
print(client.context("user-1", query="评审关注点").prompt)
```

### MCP（DSH / Claude）

```bash
MNEMOS_BASE_URL=http://127.0.0.1:4380 \
MNEMOS_API_KEY=mnemos_live_… \
MNEMOS_PARTITION=mnemos-dev \
MNEMOS_PERSON=dsh-agent \
node integrations/mcp-mnemos/src/index.js
```

### LangChain

```python
from mnemos_langchain import MnemosStore

store = MnemosStore(base_url="http://127.0.0.1:4380", api_key="mnemos_live_…",
                    namespace=("mnemos-dev", "dsh-agent"))
store.mset([("k1", {"topic": "retrieval"})])
print(store.mget(["k1"]))
```

### DSH 插件（工作区 = 分区，记忆按人）

[`integrations/dsh-mnemos-personal`](integrations/dsh-mnemos-personal/README.md) 把 Mnemos 接进
DeepSeek Harness（dsh）：

- **工作区 = 分区**：`slug = ws-<basename>-<sha1(规范化绝对路径) 前 8 位>`（如 `ws-demo-1a2b3c4d`），
  不同工作区硬隔离；也可配置 `fixed` 模式共享一个分区。
- **人 = 记忆主体**：默认人 `personId=dsh-agent`（`type=agent`）；工具可显式传 `person_id`。
- **8 个工具**：`mnemos_workspace` / `add` / `search` / `get` / `brief` / `context` / `person` / `status`，
  全部返回 `{ok,error,action}` 不抛异常；`readOnly` 拦截写入。
- **配置页字段**：`baseUrl`、`orgApiKey`、`personId`、`personType`、`partitionMode`、`fixedPartition`、
  `readOnly`、`systemPrompt`；全部热更新。
- **安装**（示例 profile `desktop`）：

  ```bash
  cd integrations/dsh-mnemos-personal
  pnpm install --ignore-workspace
  pnpm build
  dsh plugin --profile desktop add link:$PWD
  ```

  然后在「设置 → 插件 → dsh-mnemos-personal」填 `baseUrl` 与 `orgApiKey`。

---

## 与 v5 的关系

- v6 在分支 `v6-rebuild`/`main` 上**重建**；v5 完整保留在 `v5` 分支，可继续检出使用。
- **数据不迁移**：v5 使用 `data/`（`projects` 等旧表），v6.1 使用 `data-v6/`。
  v6 启动时检测到 v5 schema 会**拒绝启动**；v6/v6.1 库会自动升级到 schema v8（含隐私规则表）。
- **端点不兼容**：`/v1/projects/...`、`/v1/agents/...`、`/v1/tasks/...`、`/v1/memories`、
  `/v1/memories/search`、`/v1/context`、`/v1/graph` 等全部移除；改为
  `/v1/partitions/:p/persons/:person/...`。v5 的 `page/page_size + total` 改为游标分页。
- **领域删除**：Agent 注册表、任务会话、任务简报、项目记录、复盘、报告、Webhooks 在 v6 不存在，
  也不提供兼容层。v6.1 以新的混合检索 / 实体图 / 画像重新提供质量能力。
- v5 的文档、迁移指南与 SDK 历史版本请从 `v5` 分支获取；本仓库当前文档只描述 v6.1。

---

## 项目结构

```
mnemos/
├── server/src/            # Node + TypeScript 服务端（原生 node:sqlite，无框架）
│   ├── engine/            # partitions/persons/memories/retrieval/jobs/profile/graph/attachments
│   ├── http/              # 路由、认证、序列化、幂等、静态资源
│   ├── platform/          # 日志、指标、配额、备份、维护
│   ├── db/                # schema.sql、迁移（v6→v7）、连接
│   └── seed/              # 演示数据
├── shared/src/            # 服务端/控制台共用的 v6.1 类型与常量
├── web/                   # React 19 + Vite 控制台
├── sdk/typescript/        # TypeScript SDK
├── sdk/python/            # Python SDK
├── integrations/
│   ├── dsh-mnemos-personal/   # DeepSeek Harness 插件
│   ├── mcp-mnemos/            # MCP server
│   └── langchain-mnemos/      # LangChain BaseStore 适配器
├── scripts/               # seed-scale / perf-persons / backfill-embeddings / eval-memory / preflight
├── docs/                  # 架构、API、规模、运维、评测、安全、可观测性、路线图
├── data-v6/               # 运行数据（gitignore；pnpm seed 生成）
└── .env.example           # v6.1 环境变量示例
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/roadmap-v6.1.md`](docs/roadmap-v6.1.md) | v6.1 契约、P0/P1/P2 完成状态与验收证据 |
| [`docs/v6-architecture.md`](docs/v6-architecture.md) | v6 唯一契约：模型、存储、API、控制台、性能、插件、验收 |
| [`docs/architecture.md`](docs/architecture.md) | 实现架构：schema v8、索引、检索融合、写管线、jobs、画像、图、附件、隐私规则、加密 |
| [`docs/api.md`](docs/api.md) | API 参考：鉴权、游标、v1 与控制台端点、检索信号、历史/反馈、画像/生命周期、隐私规则与占位符、错误码 |
| [`docs/privacy-rules.md`](docs/privacy-rules.md) | v6.2 隐私规则域：模型与合并、regex/prompt 扫描、占位符协议、端点、实现与限制 |
| [`docs/v6-scale.md`](docs/v6-scale.md) | 百万级设计、检索候选/延迟预算、seed-scale/perf-persons、验收步骤 |
| [`docs/eval.md`](docs/eval.md) | 评测 harness（`pnpm eval`）：7 场景、阈值、JSON 输出与 CI |
| [`docs/operations.md`](docs/operations.md) | 部署、配置、备份恢复、jobs/回填/reconcile、维护、升级、排障 |
| [`docs/production-readiness.md`](docs/production-readiness.md) | 成熟度矩阵、SLO、容量、发布/回滚与上线检查清单 |
| [`docs/security.md`](docs/security.md) | 威胁模型、控制项、密钥生命周期、事件响应 |
| [`docs/observability.md`](docs/observability.md) | 指标、trace、Grafana 面板与告警 Runbook |
| [`docs/design-system.md`](docs/design-system.md) | 控制台视觉与组件约定 |

## 状态与已知限制

- 单节点、单写者（SQLite WAL）；多副本/Postgres 未实现。
- 向量检索是**本地 hash-384 embedding + 内存 cosine 重排**（候选 ≤700），不是 ANN/向量库；
  超大规模（千万级记忆）需换专用向量索引。
- 实体抽取是规则实现（CJK 词典 + 英文词 + 引号）；不做 LLM 事实抽取，画像摘要可选 LLM。
- 异步任务与 worker 同进程；多副本/队列不在本期。
- 导入后计数/ FTS 需要 `reconcile` / rebuild 的场景见 [v6-scale](docs/v6-scale.md)。
- v6.1 自带 `pnpm eval`、`pnpm backfill:embeddings`、`scripts/seed-scale.ts`、`scripts/perf-persons.ts`、
  `scripts/preflight.ts`；v5 时代的旧脚本已删除。
