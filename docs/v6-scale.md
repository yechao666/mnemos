# 百万级设计与压测

> 目标：一个分区 **100 万人**（或等量智能体）时，控制台人列表、搜索、统计与记忆列表仍然可用：
> 不 `COUNT(*)`、不 `OFFSET` 深翻页、不逐行查统计、页面不一次性持有全量数组。
>
> 配套：[架构](architecture.md) · [API](api.md) · [运维](operations.md)。脚本：
> `scripts/seed-scale.ts`、`scripts/perf-persons.ts`。

---

## 1. 设计要点

| 维度 | v6 做法 | 解决的问题 |
| --- | --- | --- |
| 分页 | **keyset 游标**（`WHERE (sort_value,id) < (?,?)` + `ORDER BY ... LIMIT limit+1`） | 深翻页 `OFFSET 100000` 线性变慢 |
| 总数 | **不返回 total**；头部统计读 `partition_stats`（单行主键） | 百万行 `COUNT(*)` 全表扫描 |
| 搜索 | FTS5 前缀检索（`q*`，最多 8 个词 AND） | 大表 `LIKE '%q%'` 无法走索引 |
| 计数 | `persons` 行内反规范化 `memory_count/shared_memory_count/session_count` | 列表 N+1、逐行聚合 |
| 排序 | `recent/new/name` 各有索引（带/不带 status 过滤） | 内存排序 / 临时 B-tree |
| UI | 服务端每页 50 + 自实现窗口化（固定行高 56px，只渲染可视行） | DOM/数组随总数增长 |
| 写入 | 单条 INSERT，触发器同步 FTS 与计数 | 读写分离的额外一致性成本 |
| 检索（v6.1） | 候选上限 700 + 内存 cosine 融合 | 全表扫 embedding / `ORDER BY` 大结果集 |

关键索引见 [`architecture.md` 第 3 节](architecture.md#3-表索引与状态)。改索引前先用
`EXPLAIN QUERY PLAN` 验证列表 SQL 仍然 `SEARCH persons USING INDEX ...` 且没有 `TEMP B-TREE`。

---

## 2. 种子数据：`scripts/seed-scale.ts`

```bash
# 默认：10 万人 + 1/10 的人写 1–3 条记忆；写到 data-v6/scale.db
pnpm seed:scale

# 100 万人，写到 /tmp（推荐，不污染真实数据目录）
node scripts/seed-scale.ts --persons=1000000 --db=/tmp/mnemos-scale-1m.db

# 每人 1000 条记忆的性能样本（只给第 0 个人写，用于记忆列表压测）
node scripts/seed-scale.ts --persons=100000 --heavy-memories=1000 --db=/tmp/mnemos-scale-100k.db
```

参数（全部可选）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--persons=` | `100000` | 生成人数（可 1,000,000） |
| `--db=` | `data-v6/scale.db` | 目标 SQLite 路径；**拒绝**写入 v5 的 `data/` |
| `--batch=` | `10000` | 每批事务行数；内存紧张时调小（如 2000） |
| `--slug=` | `scale` | 分区 slug（org 为 `scale-org`） |
| `--memory-every=` | `10` | 每 N 个人写一批记忆 |
| `--memories-per-person=` | `3` | 每人最多几条（1–20） |
| `--heavy-memories=` | `0` | 给第 0 个人额外写 N 条记忆（压记忆列表用） |

行为与注意事项：

- 脚本自己执行 `migrate()`；FTS 与计数触发器**保持开启**（与生产同一路径），
  因此种子耗时包含真实索引成本。
- 为提速会临时 `PRAGMA synchronous=OFF; wal_autocheckpoint=0`（只影响该进程），
  结束前 `wal_checkpoint(TRUNCATE)`。
- 结束时打印 JSON：`personsInserted`、`memoriesInserted`、`personsPerSecond`、`totalMs`，
  以及 `stats.countsMatch`（触发器计数 vs 实际 `COUNT(*)` 的校验）。
- `--persons` 很大时建议在低峰/独立机器跑；1M 人单库约 1GB 级别（见第 4 节）。

本机实测（Apple Silicon，Node 26，NVMe）：

```
--persons=100000  → 100000 人 + 19999 条记忆，totalMs 16380（约 16s，7.6k 人/秒）
                     stats.countsMatch = true
--persons=5000    → 5000 人 + 2019 条记忆，totalMs 705（约 0.8s，10.9k 人/秒）
```

按同机线性外推，100 万人约 **2.5–3 分钟**（以实测为准；磁盘较慢的机器会更久）。

---

## 3. 检索候选与延迟预算（v6.1）

v6.1 的混合检索**不做全表扫描**：先取有上限的候选集，再在内存做 cosine 重排与权重融合。

| 候选来源 | 上限 | 说明 |
| --- | --- | --- |
| FTS5 前缀/子串 | **300** | `memories_fts` 前缀命中（CJK 退化为子串 `LIKE`） |
| 该人最近记忆 | **200** | `scope IN (person, session)`，`created_at DESC` 索引 |
| 分区共享最近记忆 | **200** | `scope=partition`，`created_at DESC` 索引 |
| 去重后总候选 | **≤700** | 按 memory id 去重；`mode=vector` 候选不足时补最近记忆 |

融合：

```
score = w_vector·cosine + w_keyword·keyword + w_recency·recency
      + w_importance·importance + w_entity·entity
```

默认权重 `0.45 / 0.3 / 0.15 / 0.1 / 0`，可在 `settings.retrieval_weights` 调整。

延迟预算（单分区、单进程 SQLite，本机量级）：

| 场景 | 预期/预算 |
| --- | --- |
| `top_k=8` hybrid（候选 ≤700） | p95 **< 50ms**（内存 cosine + 一次候选 SQL） |
| `mode=keyword` | p95 **< 20ms**（复用 FTS 索引） |
| `mode=vector` | p95 **< 50ms**（候选不足时补最近 500 条） |
| 候选 SQL 本身 | 受 `LIMIT` 与索引约束，不随分区记忆总量线性增长 |

> 以上是预算而非 SLA；实际值随候选数、正文长度、embedding 维度（384）与机器变化。
> 排障时先看返回的 `took_ms` / `mode` / `strategy`，再用 `EXPLAIN QUERY PLAN` 确认候选 SQL 走
> `idx_memories_*`，没有 `SCAN memories` 或临时 B-tree。

**1M 人列表不受影响**：检索只作用于当前分区/人的记忆候选；人列表仍走 keyset 游标 +
`partition_stats`，不做 `COUNT(*)`、不加载全量人，也不因检索新增索引而改变执行计划。
v6.1 新增的 `memories` 索引只影响记忆写入/检索，不改变 `persons` 的 8 个列表索引。

---

## 4. 压测：`scripts/perf-persons.ts`

对**运行中的服务**测 5 个场景（各 2 次预热 + N 次采样），输出 p50/p95/max 与预算是否达标。
需要服务地址 + 有 `memories:read` 权限的 API Key（**org key 或该分区的 partition key**）。

```bash
# 1) 给种子库插入一把 org key。种子库有 org 但没有 users（seed-scale 不建账号），
#    无法登录控制台；压测只需要一把能读该分区的 key。生产环境请勿这样做。
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { newApiKeySecret, newId, nowIso } from "./server/src/lib/ids.ts";
const db = new DatabaseSync("/tmp/mnemos-scale-100k.db");
const org = db.prepare("SELECT id FROM orgs WHERE slug = ?").get("scale-org");
const { secret, prefix, hash } = newApiKeySecret();
db.prepare("INSERT INTO api_keys (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_at, rate_limit_per_min) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 600)")
  .run(newId("key"), org.id, "org", "perf", prefix, hash, JSON.stringify(["memories:read","memories:write","admin"]), nowIso());
console.log(secret);
db.close();
' > /tmp/mnemos-scale-key.txt

# 2) 启动服务。不要设 MNEMOS_DEMO=0：种子库没有 users，会要求 bootstrap 管理员而拒绝启动；
#    保持默认 demo 模式即可（已有 org，不会自动写演示数据），控制台不可登录、v1 可用。
MNEMOS_DATA_DIR=/tmp/mnemos-scale-data \
MNEMOS_DB_PATH=/tmp/mnemos-scale-100k.db \
MNEMOS_PORT=4382 \
MNEMOS_DREAM_SCHEDULER=0 \
node server/src/main.ts

# 3) 压测
MNEMOS_PERF_KEY=$(cat /tmp/mnemos-scale-key.txt) \
node scripts/perf-persons.ts \
  --base-url=http://127.0.0.1:4382 \
  --partition=scale \
  --iterations=20 \
  --limit=50 \
  --q=user_

# 只看某个人的记忆列表
node scripts/perf-persons.ts --base-url=... --partition=scale --key=... \
  --person=prs_seed_0 --memory-limit=50
```

| 场景 | 请求 | 预算（p95） |
| --- | --- | --- |
| `persons.list` | `GET /persons?limit=50` | < 100ms |
| `persons.search` | `GET /persons?limit=50&q=user_` | < 300ms |
| `stats` | `GET /stats` | < 10ms |
| `person.detail` | `GET /persons/:id` | < 20ms |
| `person.memories` | `GET /persons/:id/memories?limit=50` | < 100ms |

本机对 **10 万人**种子分区实测（20 轮采样，limit 50）：

```text
{"label":"persons.list","p50Ms":1,"p95Ms":4,"maxMs":4.0}
{"label":"persons.search","p50Ms":11,"p95Ms":13,"maxMs":13.1}
{"label":"stats","p50Ms":0,"p95Ms":1,"maxMs":0.9}
{"label":"person.detail","p50Ms":0,"p95Ms":1,"maxMs":0.7}
{"label":"person.memories","p50Ms":0,"p95Ms":1,"maxMs":2.8}
"pass": 全部 true
```

> v6 验证请用上方命令与 [operations](operations.md)；旧脚本已删除。
> **尚未适配 v6 端点与数据目录**。v6 的容量验证以 `perf-persons.ts` + 控制台手测为准；
> 需要并发压测时按 [`api.md`](api.md) 的端点自行编写，避免误用旧脚本。

---

## 5. 容量估算（单节点）

以 10 万人种子库的 `dbstat` 实测外推：

| 数据 | 磁盘占用（约） |
| --- | --- |
| 10 万人（含 8 个人列表索引 + FTS + 19,999 条记忆） | 109 MB |
| 100 万人 | **1.0–1.2 GB**（人索引占大头：`persons` 表 ~22.8MB/10 万，索引合计 ~78MB/10 万） |
| 每条记忆 | 约 0.25KB（含 FTS 索引，随正文长度线性增长） |

- 内存：SQLite 页缓存（默认由 OS 管理），1M 人库建议 ≥ 2GB RAM；WAL 峰值按写入并发预留。
- CPU：列表/详情是索引点查；搜索成本随 `LIMIT` 与匹配候选数增长，`q` 越短候选越多。
- 单写者：写入串行；大量导入用批事务（`seed-scale` 的做法），避免逐条 autocommit。
- 索引是双刃剑：8 个人索引让三种排序都走索引，但写入与磁盘成本上升；如果后续确定只保留
  `recent + name`，可评估删除 `new` 系列索引（需同步改 schema 与测试）。

---

## 6. 100 万人验收步骤（手动）

1. **生成**：`node scripts/seed-scale.ts --persons=1000000 --db=/tmp/mnemos-scale-1m.db`
   → 检查 `stats.personsTotal = 1000000`、`countsMatch = true`。
2. **起临时实例**（不要动 4380 / 真实 `data-v6`）：
   ```bash
   MNEMOS_DATA_DIR=/tmp/mnemos-scale-1m-data \
   MNEMOS_DB_PATH=/tmp/mnemos-scale-1m.db \
   MNEMOS_PORT=4398 \
   MNEMOS_DREAM_SCHEDULER=0 \
   node server/src/main.ts
   ```
   > 种子库没有 users，不要设 `MNEMOS_DEMO=0`（那会要求 bootstrap 管理员并拒绝启动）；
   > 保持默认 demo 模式即可（已有 org，不会自动写演示数据）。
3. **建 key**：按第 3 节第 1 步向该库插入 org key（或先给 `scale-org` 建一个控制台账号）。
4. **压测**：`node scripts/perf-persons.ts --base-url=http://127.0.0.1:4398 --partition=scale --key=... --iterations=20`
   → 对照第 3 节预算；任一场景 p95 超预算即视为不达标（记录机器规格）。
5. **UI**：打开控制台「分区 → 人」，确认：
   - 首屏统计立即出现（来自 `partition_stats`，不是 loading 后算出来的）；
   - 快速滚动到底自动加载下一页，DOM 行数保持恒定（DevTools 观察节点数不随滚动持续增长）；
   - 搜索框输入后 300ms 才发请求，URL 带 `q` 可回放；
   - 直到最后一页 `next_cursor` 为 null 才停止加载。
6. **SQL 复核**：对列表 SQL 执行 `EXPLAIN QUERY PLAN`，确认走 `idx_persons_*` 且无
   `SCAN persons` / `USE TEMP B-TREE FOR ORDER BY`。
7. **收尾**：停临时实例，删除 `/tmp` 种子库与数据目录。

---

## 7. 批量导入 / 迁移之后

- 计数可能因手工 SQL/导入工具绕过触发器而变化：调用
  `POST /api/partitions/:partition/reconcile`（控制台 admin+）重算 `partition_stats` 与人的计数。
- FTS 外部内容表若被批量工具绕过（直接写文件/ATTACH），重建索引：
  ```sql
  INSERT INTO persons_fts(persons_fts) VALUES('rebuild');
  INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
  ```
- 大库首次 `VACUUM` 会阻塞写，放在维护窗口；至少预留 2 倍库大小的空闲磁盘。

---

## 8. 已知边界与排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 搜索很慢 | 先看 `took_ms`/`mode`：`keyword` 慢多为 CJK 子串回退；`vector` 慢看候选与 embedding 是否缺失。缩短查询、加 `category/scope` 过滤、降低 `top_k`。 |
| 向量信号全 0 | 旧记忆未回填 embedding；`pnpm backfill:embeddings` 或等 `memory_jobs` worker。 |
| 翻页结果重复/跳行 | 游标必须与当前 `sort` 配套；换了排序要丢弃旧游标（服务端返回 `400 INVALID_CURSOR`）。 |
| 列表 p95 高 | 检查是否有人为加了 `COUNT(*)` / 逐行 stats 请求；确认 `partition_stats` 行存在（`reconcile` 可补）。 |
| 人计数为 0 但记忆存在 | 绕过触发器写入；执行 `reconcile`。 |
| 写入 p95 抖动 | 单写者 + `synchronous=NORMAL`；避免与 VACUUM/大备份并发；导入用批事务。 |
| 磁盘增长快 | 8 个人索引 + FTS 是主要成本；评估删除不用的排序索引，或按分区归档旧数据。 |
