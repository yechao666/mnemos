# Mnemos v6 —— 中立记忆服务（重建）

> v5 是在旧平台（项目 / Agent / 任务 / 报告 / Webhooks / 图谱）上叠加「人」维度；v6 是**重建**：
> 只保留 **分区（Partition）+ 人（Person）+ 记忆（Memory）** 三个核心，围绕百万级人列表设计存储、API 与界面。
>
> 本文件是 v6.0 的基线契约。**v6.1 已在此基础上扩展**（schema v7、混合检索、历史/反馈、
> 画像/生命周期、实体图、多模态附件、PII/加密），新增能力以
> [`roadmap-v6.1.md`](roadmap-v6.1.md) 与 [`architecture.md`](architecture.md) 为准；
> v6.0 的端点与字段保持兼容。
>
> 旧领域（agents / tasks / 任务简报 / 项目记录 / 复盘 / 报告 / webhooks）在 v6 一律删除，
> 不做兼容；v6.1 用新的 entities / relations / memory_attachments 重新提供图与多模态。

## 1. 核心模型

```
Partition（分区：App / 项目 / 租户）
  └── Person（人：human | agent | service）
        ├── Memory（person_id NOT NULL；scope=person | partition | session）
        ├── Session（可选：一次对话 / 任务）
        └── Brief / Dream（人级）
Partition 级：共享简报、分区统计、密钥、用量、审计
```

- **记忆永远属于一个「人」**（`person_id NOT NULL`）：App 用户、员工、智能体都是人；没有「无人记忆」。
- **共享**由记忆级 `scope` 决定：`partition` = 分区共享（多人可见）；`person` = 仅本人；`session` = 仅该会话。
- 人不是登录账号；控制台账号（org users）只用于登录与权限。
- 会话（Session）是可选分组，仅用于把同一串交互归组；不引入任务/Agent 领域。

## 2. 存储契约（schema v6，干净重建）

```sql
-- 组织与控制台账号（保留，仅用于登录/权限）
orgs(id, name, slug, plan, created_at)
users(id, org_id, email, name, role, password_hash, status, ...)
user_sessions(id, user_id, token_hash, expires_at, ...)

-- 分区（取代 projects，命名正式改为 partitions）
partitions(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'active',
  settings TEXT DEFAULT '{}', created_at, updated_at, archived_at,
  UNIQUE(org_id, slug)
)

-- 人（一等实体；列表用反规范化计数，避免 N+1 / COUNT(*)）
persons(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL,
  external_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'human',
  display_name TEXT DEFAULT '', attributes TEXT DEFAULT '{}',
  status TEXT DEFAULT 'active',
  memory_count INTEGER DEFAULT 0,         -- scope=person + session 属于本人
  shared_memory_count INTEGER DEFAULT 0,  -- 该作者的 scope=partition 记忆
  session_count INTEGER DEFAULT 0,
  last_memory_at TEXT, first_seen_at TEXT, last_seen_at TEXT,
  created_at, updated_at,
  UNIQUE(partition_id, type, external_id)
);
-- 列表/搜索索引（百万级）
CREATE INDEX idx_persons_recent ON persons(partition_id, status, last_seen_at DESC, id DESC);
CREATE INDEX idx_persons_type   ON persons(partition_id, type, status, last_seen_at DESC, id DESC);
CREATE INDEX idx_persons_name   ON persons(partition_id, display_name, id);
CREATE INDEX idx_persons_ext    ON persons(partition_id, external_id);
-- FTS5（外部内容表 + 触发器）
persons_fts(external_id, display_name) content='persons';

-- 记忆
memories(
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, person_id TEXT NOT NULL,
  actor_person_id TEXT, scope TEXT NOT NULL DEFAULT 'partition',
  session_id TEXT, category TEXT DEFAULT 'fact',
  content TEXT NOT NULL, importance REAL DEFAULT 0.5, confidence REAL DEFAULT 0.8,
  source TEXT DEFAULT 'api', status TEXT DEFAULT 'active',
  tags TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}',
  created_at, updated_at, expires_at, dreamed_at
);
CREATE INDEX idx_memories_person ON memories(partition_id, person_id, status, created_at DESC, id DESC);
CREATE INDEX idx_memories_scope  ON memories(partition_id, scope, status, created_at DESC, id DESC);
memories_fts(content) content='memories';  -- 检索用，不再自建 BM25 词项表

-- 会话（可选）
sessions(id TEXT PRIMARY KEY, partition_id, person_id, title, status,
         started_at, ended_at, metadata)

-- 简报 / 复盘（人级 + 分区级）
memory_briefs(partition_id, scope_key TEXT, person_id, text, max_chars, model, source_hash, generated_at,
              PRIMARY KEY(partition_id, scope_key));
dream_runs(id, partition_id, person_id, trigger, status, input_count, insight_count,
           summary, error, started_at, finished_at);

-- 密钥（分区 / 组织）
api_keys(id, partition_id, org_id, kind TEXT DEFAULT 'project', name, prefix, key_hash,
         scopes, rate_limit_per_min, expires_at, allowed_ips, revoked_at, ...);

-- 分区统计（头部聚合；由触发器/事务维护，列表页不再 COUNT(*)）
partition_stats(
  partition_id TEXT PRIMARY KEY,
  persons_total INTEGER DEFAULT 0, persons_human INTEGER DEFAULT 0,
  persons_agent INTEGER DEFAULT 0, persons_service INTEGER DEFAULT 0,
  memories_total INTEGER DEFAULT 0, shared_total INTEGER DEFAULT 0,
  sessions_total INTEGER DEFAULT 0, updated_at
);

-- 基础运营
usage_events, audit_logs
```

计数维护：persons / memories 的 INSERT/UPDATE/DELETE 用 SQLite 触发器维护 `partition_stats` 与 `persons.memory_count/shared_memory_count`；`last_memory_at/last_seen_at` 写入时更新。迁移/批量导入后执行一次 `reconcile` 校准。

**删除（v6 不存在的表）**：agents、tasks、entities、relations、memory_entities、memory_terms、webhooks、webhook_deliveries、reports/records 相关、maintenance_runs 以外旧域表一律不建。

## 3. API（v6，干净面）

所有端点默认在 `/v1/partitions/:partition/` 下；`:partition` 支持 id 或 slug。JSON snake_case。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/partitions` | 建/幂等 upsert 分区（org key + admin） |
| GET | `/v1/partitions/:p` | 分区信息 + settings（不含敏感） |
| GET | `/v1/partitions/:p/stats` | 分区统计（直接读 partition_stats，O(1)） |
| GET | `/v1/partitions/:p/persons` | 人列表：**游标分页** `cursor&limit&q&type&status&sort` |
| PUT | `/v1/partitions/:p/persons/:externalId` | 建档/更新人 |
| GET/PATCH | `/v1/partitions/:p/persons/:person` | 人详情/更新（person=内部 id 或 external） |
| GET | `/v1/partitions/:p/persons/:person/memories` | 该人记忆：游标分页 + scope/category |
| POST | `/v1/partitions/:p/persons/:person/memories` | 写记忆（person 必填；scope 缺省取分区设置） |
| GET/PATCH/DELETE | `/v1/partitions/:p/memories/:id` | 记忆详情/更新/删除 |
| GET | `/v1/partitions/:p/memories` | 记忆全局列表：person_id/scope/category/cursor |
| GET | `/v1/partitions/:p/persons/:person/brief` | 人级简报 |
| POST | `/v1/partitions/:p/persons/:person/context` | 人级上下文（资料+简报+记忆+共享） |
| GET/POST | `/v1/partitions/:p/persons/:person/dream`、`/dream/run` | 人级做梦 |
| GET/POST | `/v1/partitions/:p/dream`、`/dream/run` | 分区级做梦 |
| GET | `/health` | 健康检查 |

**分页协议（所有人/记忆列表）**：
```json
{ "items": [...], "next_cursor": "eyJ2IjoiMjAyNi0xMS0xN1Qx...", "partition_stats": {...} }
```
- 游标 = base64url(JSON `{v, id, s}`)（`s` 为排序值），服务端 keyset：`WHERE (sort_value, id) < (?, ?)`（recent/name/new 三种排序各有索引）。
- `limit` 默认 50、最大 200；**不返回 total**（避免百万行 COUNT）；头部统计读 `partition_stats`。
- 搜索：`q` 走 FTS5 前缀匹配（`q*`）；`q` 为空走索引排序。前缀 < 3 字符时可退化为 `LIKE 'q%'`（走 external_id/name 索引）。
- 响应不包含每个人逐条统计（计数已反规范化在 persons 行上）。

兼容：v6 **不保留** `/v1/memories`、`/v1/agents`、`/v1/tasks`、`/v1/context`、`/v1/projects` 等旧端点。

控制台 `/api` 与 v1 同构（camelCase），权限沿用组织角色 + 分区成员；org key 管理保留。

## 4. 控制台（重建）

信息架构：**组织 → 分区 → 人 → 记忆**。

- 分区列表：名称/slug/状态 + `partition_stats` 计数（人/记忆/共享）+ 最近活跃；卡片或表格。
- 分区概览：统计卡（人/人类型分布/记忆/共享/会话）、最近活跃人、最近记忆；全部读统计表与游标列表，不做全表扫描。
- 人列表（核心，百万级）：
  - 头部统计来自 `partition_stats`；不做 `COUNT(*)`、不逐行查 stats。
  - 搜索框：FTS 前缀搜索，300ms 防抖；类型/状态筛选；排序（最近活跃/新建/姓名）。
  - **游标分页 + 虚拟滚动**：每页 50，滚动到底自动加载下一页；只渲染可视窗口行（行高固定 56px），万级滚动不卡。
  - 行内容极简：显示名 / external_id / 类型 / 记忆数 / 最近活跃；点击进详情。
  - 空态、错误态、加载骨架；筛选条件写入 URL query，可回放。
- 人详情：资料头 + 计数（来自 persons 行）+ 最近记忆（游标加载更多）+ 人级简报（按需生成/读取）+ 做梦状态（按需）；记忆不一次全量加载。
- 记忆页：游标列表 + person/scope/分类筛选 + 全文搜索；不提供「全选全部」这类百万级操作，批量仅限当前页。
- 保留：密钥（分区/组织）、用量、审计、设置、API 文档。删除：Agent、任务、项目记录、复盘总结、事件订阅、成员页（控制台账号在组织设置管理）。
- **v6.1 增量**：记忆页增加检索信号/历史时间线/反馈/时效徽标/附件；人详情增加画像卡与生命周期操作；新增分区「图谱」页。

## 5. 性能预算（百万级）

- 种子：脚本可生成 1,000,000 人（分批事务 + FTS 触发），分区统计正确；本机实测 100 万约 140 秒（以机器为准）。
- API（1M 人）：`GET persons?limit=50` p95 < 100ms；`q` 前缀搜索 p95 < 300ms；`GET stats` < 10ms；人详情 < 20ms；记忆列表（每人 1000 条）p95 < 100ms。
- UI：首屏 < 1s；滚动加载 50 行 < 200ms；DOM 行数恒定（虚拟滚动）；无全量数组驻留内存。
- 验证：脚本 `scripts/perf-persons.ts` 生成数据 + 计时；测试断言阈值。

## 6. DSH 插件

保留 `integrations/dsh-mnemos-personal`（桌面已安装，配置页保留）：
- 配置页字段不变：baseUrl / orgApiKey / personId / personType / partitionMode / fixedPartition / readOnly / systemPrompt。
- 客户端改为 v6 API：分区 upsert、persons 游标列表（`cursor/limit`）、记忆写/查、人级 brief/context/dream。
- 工作区 → 分区 slug 规则不变（`ws-<basename>-<hash8>`）；默认人 dsh-agent。
- 工具保持 8 个：mnemos_workspace / add / search / get / brief / context / person / status。
- 重建 lib 后重新 link 安装（路径不变），desktop 重载生效。

## 7. 重建策略

- 新分支 `v6-rebuild`；同一仓库内重建，保留 v5 分支作为历史。
- 复用**基础设施**：SQLite 封装、密码哈希、会话鉴权、LLM 调用、控制台 UI 基础组件/设计 token、格式化工具。
- 重写**领域**：schema、engine、API、控制台页面、SDK、文档。
- 旧代码目录直接删除（agents/tasks/webhooks/graph/reports/records/retrospective 等），不做兼容层。
- v5 数据（data/mnemos.db）保留不迁移；v6 使用 `data-v6/`，演示数据由 v6 seed 生成（含 1 个 App 分区与 1 个研发分区）。

## 8. 验收

1. `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
2. 1M 人分区：列表/搜索/统计性能达标；UI 虚拟滚动可用；无 COUNT(*) 全表扫描。
3. 两个基准场景：知物感恩 App（人=user_id，私有）；mnemos 代码项目（人=agent，共享+私有）。
4. DSH 插件在桌面配置页可填地址与 org key，工作区=分区、按人读写验证通过。
5. 旧领域彻底移除：代码/路由/导航/文档中不再出现 Agent/任务/项目记录/复盘/Webhooks；
   v6.1 的实体图使用新的 `entities/relations` 表与 `/graph` 路由，不是 v5 兼容层。
