# 从 v4 迁移到 v5（中立记忆服务：分区 + 人）

> 适用版本：Mnemos `schema_version=4` → `5`。v5 把记忆模型从「项目 × Agent × 任务」升级为
> **「分区（Partition）× 人（Person）」**，同时保留全部旧接口、旧字段与旧 SDK 调用（只增不改）。
>
> 契约：[`neutral-memory-model.md`](neutral-memory-model.md)；模型说明：
> [`agent-memory-model.md`](agent-memory-model.md)；接口：[`api.md`](api.md) 第 11 节。

## 1. 迁移摘要

| 项 | v4 | v5 | 兼容策略 |
| --- | --- | --- | --- |
| 隔离边界 | 项目（Project） | 分区（Partition，存储仍是 `projects`） | `/v1/projects/:id` 作为 `/v1/partitions/:id` 的全量别名 |
| 记忆主体 | `user_id` / `agent_id` 两个自由字段 | `persons` 表 + `memories.person_id` / `actor_person_id` | 旧字段保留并双写；写入时自动映射/建档 |
| 可见性 | `visibility` = project / agent / task | `scope` = partition / person / session | 一一映射、双写；旧字段可继续读写 |
| 会话 | `task_id` / `run_id` | `session_id` | `session_id = COALESCE(task_id, run_id)`，旧列保留 |
| 简报 / 做梦 | 项目级 | 人级 + 分区级 | 旧 `/api/projects/:id/memory/*` 保留；新增人级端点 |
| API Key | 仅项目级 | `kind=project` / `kind=org` | 旧密钥回填 `kind='project'`；org key 新能力 |
| 版本号 | `meta.schema_version = 4` | `5` | 启动时幂等迁移 |

v5 是**加法式**变更：新增 `persons` 表、`memories` 4 列（`person_id` / `actor_person_id` / `scope` /
`session_id`）、`memory_briefs.person_id`、`memory_dream_runs.person_id`、`api_keys` 2 列
（`kind` / `org_id`）。没有列/表被删除，没有既有字段语义被改变。

## 2. 升级步骤

```bash
# 0) 先备份（强烈建议；v5 迁移会写 person / scope 回填）
cp data/mnemos.db data/backups/mnemos-v4-$(date +%Y%m%d%H%M%S).db

# 1) 停服（避免迁移期间写入）
#    容器：docker compose stop mnemos；裸机：停止 pnpm start 的进程

# 2) 升级代码到 v5 并安装依赖
pnpm install

# 3) 启动：migrate() 会自动执行
#    ensureColumns（补列）→ schema.sql（建 persons 等）→ 迁移 v5 数据回填
pnpm start        # 或 docker compose up -d

# 4) 验证（见第 5 节）：schema_version=5、persons 已建档、scope 已回填、旧接口仍可用

# 5) 业务切流：旧调用方无需改动；需要「人」维度的新功能逐步切到 /v1/partitions/* 端点
```

迁移由 `server/src/db/index.ts` 的 `migrate()` 驱动，在**每个事务内**执行单条迁移，失败回滚并抛错：

1. `ensureColumns()`：逐列检查后 `ALTER TABLE ADD COLUMN`（SQLite 无 `ADD COLUMN IF NOT EXISTS`）；
2. 执行 `schema.sql`：`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`；
3. 按 `meta.schema_version` 执行未应用的迁移（v5 迁移名 `neutral-person-model`）。

迁移可重复执行（幂等）；如果进程在迁移中途崩溃，事务回滚后重启会重跑。

## 3. 数据回填规则

v5 迁移只做「能从旧数据确定推出」的回填，不凭空造数据：

1. **Agent 人**：遍历 `memories` 中 distinct `(project_id, agent_id)` → 建
   `person(type=agent, external_id=agent_id, display_name=agents.name)`；把该分区该 agent 的记忆
   `person_id` / `actor_person_id` 回填为这个人。
2. **真人**：遍历 distinct `(project_id, user_id)`（**排除已有 `agent_id` 的行**，避免同一行被两种人覆盖）
   → 建 `person(type=human, external_id=user_id)`；回填 `person_id` / `actor_person_id`。
3. **scope**：按旧可见性回填——`project→partition`、`agent→person`、`task→session`；
   `session_id = COALESCE(task_id, run_id)`。
4. **人级缓存**：`memory_briefs.person_id` / `memory_dream_runs.person_id` 迁移时保持 `NULL`
   （旧缓存/旧运行都是分区级）。
5. **org_id**：`api_keys.org_id` 回填为所属分区的 `org_id`；`kind` 默认 `project`。
6. **不造人**：`person_id` 为空且 `scope=partition` 的旧记忆视为**分区共享知识**，保持 `person_id=NULL`。

> 注意：旧模型允许一行记忆同时带 `user_id` 与 `agent_id`（例如「客户 × 客服机器人」）。
> v5 只能选一个人归属，回填时 **`agent_id` 优先**（先建 agent 人并回填，真人迭代再排除这些行）。
> 若业务需要「客户本人」作为主体，见第 4 节同人合并/改归属建议。

## 4. 同人与归属处理建议

### 4.1 识别重复人

迁移不会合并「同一个人/同一个 Agent 在旧数据里出现多种写法」的记录。升级后建议先盘点：

```sql
-- 同一分区、同一类型、external_id 仅大小写/空白差异（SQLite 默认区分大小写，需人工判断）
SELECT project_id, type, external_id, COUNT(*) FROM persons GROUP BY project_id, type, external_id;

-- 同一分区、同一 external_id 同时存在 human 与 agent 两条（历史遗留）
SELECT external_id, project_id, GROUP_CONCAT(type) FROM persons
GROUP BY project_id, external_id HAVING COUNT(DISTINCT type) > 1;
```

### 4.2 合并建议

1. **先定 canonical 人**：保留最早创建（或业务确认）的 `prs_…` 为主，其余标记 `status='archived'`
   （不要直接删除，保留审计可追溯）。
2. **改归属**：把被合并人的记忆改到主 person（`person_id`、`actor_person_id` 同步）：
   ```sql
   UPDATE memories SET person_id = 'prs_主' WHERE person_id = 'prs_从';
   UPDATE memories SET actor_person_id = 'prs_主' WHERE actor_person_id = 'prs_从';
   ```
   `memory_history` 与 `audit_logs` 是历史证据，**不要改写**；如需留痕，另写一条审计说明
   （控制台 PATCH 人 / 管理 API 会写 `person.update` 审计）。
3. **改 attributes**：把被合并人的画像合并到主 person 的 `attributes`，再归档从人。
4. **报告与沟通**：把「同分区同类型重复 external_id」清单交给业务确认；v5 暂不提供 `persons/merge`
   合并 API（后续版本），当前用控制台/API 手工归档 + SQL 改归属，操作前备份。
5. **不要跨分区合并**：分区是硬边界，跨分区同 `external_id` 是两个不同的人（不同业务/租户）。

### 4.3 需要把人改到另一位（而非合并）时

- 单条记忆：`PATCH /v1/partitions/:p/memories/:id` 目前只支持正文/分类/重要度/状态/标签/元数据，
  **不支持改归属**；请用 SQL（`UPDATE memories SET person_id=? WHERE id=?`）或重建记忆。
- 批量：按 `metadata`/时间范围筛选后批量 SQL；改完调用 `GET .../persons/:person` 复核 stats。

## 5. 验证清单

```bash
# 1) schema 版本
sqlite3 data/mnemos.db "SELECT key, value FROM meta WHERE key='schema_version';"   # → 5

# 2) 表 / 列存在
sqlite3 data/mnemos.db "SELECT COUNT(*) FROM persons;"
sqlite3 data/mnemos.db "PRAGMA table_info(memories);" | grep -E 'person_id|scope|session_id'

# 3) 回填完整性：除分区共享知识外，不应有大量 person_id 为空
sqlite3 data/mnemos.db "SELECT scope, person_id IS NULL AS no_person, COUNT(*) FROM memories GROUP BY 1,2;"

# 4) 旧接口回归（project key）
curl "$BASE/v1/memories?user_id=cust-1042&page=1" -H "Authorization: Bearer $KEY"
curl -X POST $BASE/v1/memories/search -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"query":"周报","agent_id":"agent-support-l1"}'

# 5) 新接口冒烟（org key，见 README「org key」）
curl "$BASE/v1/partitions/<旧项目id>/persons" -H "Authorization: Bearer $ORG_KEY"
curl "$BASE/v1/partitions/<slug>/persons/<external-id>/brief" -H "Authorization: Bearer $ORG_KEY"
```

- 迁移后 `pnpm typecheck` / `pnpm test` 全绿；
- 控制台可打开「人」页签、记忆页的「人 / scope」筛选、人详情与简报；
- 若旧库从未执行过 v4 迁移（`schema_version=0`），`migrate()` 会直接按最新 schema 初始化并**不做回填**
  （视为新库）；这种情况请从备份恢复后按正常升级流程处理。

## 6. 旧接口 → 新接口映射表

### 6.1 端点

| v4 | v5 | 说明 |
| --- | --- | --- |
| `POST /v1/memories` | `POST /v1/partitions/:p/memories` | 新增 `person_id` / `person_external_id` / `scope` / `session_id` |
| `POST /v1/memories/search` | `POST /v1/partitions/:p/memories/search` | 新增按人 / scope 过滤 |
| `GET /v1/memories` | `GET /v1/partitions/:p/memories` | 新增 `person_id` / `scope` / `q` / `include_private` |
| `GET/PUT/DELETE /v1/memories/:id` | `GET/PATCH/DELETE /v1/partitions/:p/memories/:id` | 更新方法由 `PUT` 改为 `PATCH`（旧 `PUT` 保留） |
| `POST /v1/context` | `POST /v1/partitions/:p/persons/:person/context` | 人级上下文（资料 + 简报 + 记忆 + prompt） |
| `POST /api/projects/:id/memory/dream/run` | `POST /v1/partitions/:p/dream/run` | 分区级；人级用 `.../persons/:person/dream/run` |
| `GET /api/projects/:id/memory/brief` | `GET /v1/partitions/:p/persons/:person/brief` | 人级简报（旧分区简报保留） |
| 无（新能力） | `POST /v1/partitions`、`GET /v1/partitions/:p` | 建 / 查分区（org key） |
| 无（新能力） | `PUT/GET/PATCH /v1/partitions/:p/persons...` | 人建档 / 列表 / 详情 / 更新 |
| `/v1/projects/:id/...` | `/v1/partitions/:id/...` | 全量别名 |

### 6.2 字段

| v4 | v5 | 说明 |
| --- | --- | --- |
| `user_id` | `person_id`（`type=human`） | 写入自动建档（分区 `personAutoCreate`） |
| `agent_id` | `person_id`（`type=agent`） | 旧列继续双写 |
| `visibility=project` | `scope=partition` | 旧列继续双写 |
| `visibility=agent` | `scope=person` | 旧列继续双写 |
| `visibility=task` | `scope=session` | 需 `session_id`（旧 `task_id` 自动映射） |
| `task_id` / `run_id` | `session_id` | 旧列保留 |
| — | `actor_person_id` | 写入者；缺省同 `person_id` |

### 6.3 SDK

TypeScript SDK `1.x` 已同步：旧方法签名不变（向后兼容），新增
`client.partitions.*`、`client.persons.*`、`client.personBrief/personContext/personDream/personDreamRun`；
`client.memories.*` 传 `partition`（及 `personId` / `scope` / `sessionId`）时走中立分区端点。

## 7. 回滚要点

v5 是加法式迁移，回滚有两种策略：

### 7.1 推荐：恢复迁移前备份

```bash
# 1) 停服
# 2) 恢复备份（v4 库）
cp data/backups/mnemos-v4-<时间戳>.db data/mnemos.db
# 3) 回退代码到 v4 并重启
# 4) 验证 meta.schema_version=4 与旧接口
```

优点：数据与 schema 完全回到迁移前，没有「v5 字段不可见」的歧义。代价：迁移后新增的数据会丢失，
所以**升级后在确认稳定前保留旧库备份，并把迁移后的写入视为新数据**。

### 7.2 应急：旧版本直接跑在 v5 库上

v5 只加列/加表，v4 的 `SELECT *` 与映射会忽略未知列，理论上可以直接运行；但要评估：

- v4 不认识 `persons` / `scope` / `person_id`：**新写入的人级记忆在 v4 中不可见**，旧接口读到的
  只是旧列双写的 `visibility` / `user_id` / `agent_id`，会出现「部分记忆看不到」；
- v4 不认识 `api_keys.kind='org'`：org key 行会按普通 project key 处理（只绑定锚点分区），
  跨分区能力消失。**回滚前请先吊销全部 org key**，避免权限语义与预期不一致；
- v4 的做梦/简报只处理分区级，人级产物（`memory_dream_runs.person_id`）会被忽略；
- `meta.schema_version` 保持 5，再次升级 v5 时不会重复回填（幂等），但回滚期间产生的数据
  不会自动补 person——需要重新执行第 3 节规则或走恢复备份。

### 7.3 回滚检查清单

- [ ] 已停写、已备份（或确认放弃迁移后数据）
- [ ] org key 已吊销（走 7.2 时）
- [ ] 旧接口回归：`/v1/memories`、`/v1/memories/search`、`/v1/context`
- [ ] 控制台记忆/简报/做梦页可用（v4 版本）
- [ ] 记录回滚原因、时间窗、影响的分区与人，便于复盘

## 8. 常见问题

| 问题 | 说明 |
| --- | --- |
| 迁移慢/卡住 | 迁移在事务内执行；大库（百万级 memories）建议低峰期升级并放宽 `MNEMOS_REQUEST_TIMEOUT_MS`，迁移本身不走请求超时 |
| 同一个人出现 human + agent 两条 | 旧数据同时带 `user_id` / `agent_id` 所致；按 4.2 节手工合并 |
| 旧记忆筛不到人 | 旧 `person_id` 为空的 `scope=partition` 记忆是分区共享，不归属任何人；需要归属时用 SQL/重写入 |
| org key 403 | 仅组织 owner 可创建；`admin` 作用域；project key 不能建分区 |
| 旧 SDK 还能用吗 | 能。旧方法签名与旧端点不变；新字段/新方法为增量 |
