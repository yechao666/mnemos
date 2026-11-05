# 存储与规模：从单节点到多副本

> 本文是 **P1 架构演进计划**，不是已完成能力。当前版本（v1.1）是单节点 SQLite/WAL 部署；
> Postgres、外部向量库、读写分离与多副本仍在分阶段实施。本文给出可执行路径、验收标准与回滚方案，
> 避免把"单机"冒充成"分布式"。

## 1. 当前边界

| 组件 | 现状 | 规模上限（经验值） |
| --- | --- | --- |
| 存储 | 单文件 SQLite（WAL，同步 API） | 千万级记忆仍可读，但单写者与备份窗口成为瓶颈 |
| 向量检索 | 进程内暴力余弦（SQL 预筛 ≤4000 条） | 单项目 1–3 万条记忆内 p95 < 100ms |
| 关键词 | 自建 `memory_terms` 倒排 + BM25 | 千万级词项行后 SQLite 索引压力显著 |
| SSE / 事件 | 进程内 `EventBus` | 多副本时跨实例事件不可见 |
| 限流 / 登录锁定 | 内存窗口 + DB 锁定 | 多副本时每实例独立计数，需共享存储 |
| Webhook worker | 单进程轮询 | 多副本会重复投递，需要租约或外部队列 |
| 备份 | `VACUUM INTO` + 本地文件 | 需异地副本与 PITR |
| 迁移 | 自研 `meta.schema_version` 迁移器 | 多实例同时启动需要迁移锁 |

结论：**单节点直连上限约 1–3 万条记忆/项目、数百 RPS**；再往上需要换存储与拆分有状态组件。

## 2. 目标架构

```
                     ┌──────────────┐
   Agents/SDK ──────▶│  N × API 副本 │  stateless（会话在 DB，限流在 Redis）
                     └──────┬───────┘
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
       ┌────────────┐ ┌───────────┐ ┌────────────┐
       │ Postgres   │ │  Redis    │ │ 对象存储    │
       │ 主库+只读   │ │ pub/sub   │ │ 备份/PITR  │
       │ pgvector   │ │ 限流/租约  │ │            │
       └─────┬──────┘ └───────────┘ └────────────┘
             ▼
       ┌────────────┐
       │ 副本 ×1..N │  只读查询、控制台列表、检索（延迟容忍）
       └────────────┘
```

- **写路径**：主库事务（记忆 + 词项 + 实体 + 历史 + 事件 outbox）。
- **读路径**：默认主库（强一致）；控制台列表/检索可路由到副本（可接受秒级延迟）。
- **事件**：事务内写 `outbox`，由 dispatcher 投递到 Redis Streams/NATS，各副本消费后推送 SSE/webhook。
- **向量**：pgvector `vector(384)` + HNSW；大规模时切换外部（Qdrant/Milvus），保留 `MemoryService` 接口。
- **维护**：Postgres advisory lock 选主，保证迁移/归档只执行一次。
- **限流/登录锁定**：Redis 滑动窗口；锁定仍落库保证重启后生效。

## 3. 分阶段计划

### Phase 0：存储接缝（1–2 天）
- 引入 `StorageDriver` 接口（async）：`query/execute/transaction/now/` 方言适配。
- 在 `env` 中增加 `MNEMOS_STORAGE`（当前仅 `sqlite`），启动时对未实现驱动显式失败。
- 把 `db/index.ts` 的连接细节收敛到 driver，业务 SQL 保持不动。
- **验收**：`tsc`/测试全绿；SQLite 行为零回归。

### Phase 1：Postgres 适配（1–2 周，最高风险）
- 把所有 `node:sqlite` 同步调用改为 `await storage.*`（引擎 ~2.5k 行、HTTP 查询层 ~1k 行）。
- Schema 映射：`TEXT` 保留、`REAL→double precision`、`INTEGER→integer/bigint`、`JSON` 文本列改 `jsonb`、时间统一 `timestamptz`。
- 索引/查询差异：`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`、`json_extract`→`->>`、`bm25` 词项表改 GIN + `tsvector`（中文继续用二元组词项表）。
- 迁移：`schema_version` 表 + 每版本 SQL 文件；启动时 advisory lock；`035` 起由 CI 跑 SQLite↔Postgres 双写对拍。
- 数据迁移：`ProjectExport`（已有 JSON 导出/导入）→ 批量导入器（分批 1k、幂等）。
- **验收**：同一套 45+ 单测/39 冒烟在 Postgres 上通过；1 万记忆检索 p95 < 150ms；导出→导入计数一致；回滚可回 SQLite。

### Phase 2：读写分离（3–5 天）
- `StorageDriver` 支持 `primary`/`replica` 两套连接池；`withReplica()` 显式路由。
- 路由策略：写与写后读（同一请求内）走主库；控制台列表、概览、审计分页走副本；检索默认主库，可配置 `readPreference=replica`。
- 副本延迟监控指标 `mnemos_replica_lag_seconds`；超阈值自动回落主库。
- **验收**：副本延迟注入 2s 时写后读一致性不受影响；kill 副本后服务降级不报 5xx。

### Phase 3：无状态多副本（1–2 周）
- 限流/登录尝试窗口迁移 Redis；SSE 改用 Redis pub/sub（每副本订阅，客户端任意副本可收）。
- Webhook outbox 用 `FOR UPDATE SKIP LOCKED` + 租约（`locked_until`），或外部队列；重复投递由 delivery 唯一键兜底。
- 维护/迁移用 advisory lock 选主；`/readyz` 增加副本角色与锁状态。
- 会话已在 DB，无需 sticky；控制台 SSE 断开重连即可。
- **验收**：2 副本压测无重复 webhook、无重复记忆写入；滚动发布零 5xx；SSE 跨副本可达。

### Phase 4：向量外置与规模（1 周）
- 当单项目 > 5 万条或检索 p95 > 200ms：接入 Qdrant（HNSW）或 pgvector HNSW。
- 保留 `retrieve.ts` 的信号融合逻辑，只替换候选集与打分来源；`memory_vectors` 双写 + 回填脚本。
- **验收**：10 万条/项目检索 p95 < 120ms；删除/更新后索引一致；可一键回退到内置向量。

## 4. 决策矩阵

| 选项 | 优点 | 代价 | 建议 |
| --- | --- | --- | --- |
| Postgres + pgvector | 事务/生态成熟，一套库；运维简单 | 迁移期需异步重写；HNSW 内存成本 | **默认路线** |
| SQLite + Litestream 复制 | 改动最小，PITR 简单 | 仍单写者，无法水平扩展 | 只用于单节点 DR |
| SQLite → Qdrant + Postgres | 检索规模最大 | 两套有状态组件，双写一致性 | 超 50 万条/项目再考虑 |
| 保持 SQLite | 零运维 | 无法多副本，写放大 | 仅演示/边缘 |

## 5. 不可妥协的迁移原则

1. **先建接缝，再换引擎**：Phase 0 之前不改业务 SQL。
2. **双跑对拍**：Postgres 适配期间保留 SQLite CI 任务，同一测试套件两处跑通。
3. **可回滚**：每阶段都有"导出→导入→切回 SQLite"的演练（已有 `ProjectExport` 与备份演练脚本）。
4. **不双写**：迁移用停止写入窗口或 outbox 回放，避免双写不一致。
5. **观测先行**：副本延迟、写放大、队列堆积必须先有指标与告警，再开多副本。

## 6. 验收与 SLO

| 阶段 | 验收 | SLO |
| --- | --- | --- |
| Phase 1 | 45 单测 + 39 冒烟在 PG 全绿 | 检索 p95 < 150ms（1 万条） |
| Phase 2 | 副本故障注入 | 可用性 99.9%，写后读一致 |
| Phase 3 | 2 副本压测 | 0 重复写入/投递，滚动发布 0 5xx |
| Phase 4 | 10 万条检索 | p95 < 120ms，索引一致 |

## 7. 当前可用的相关能力

虽然多副本尚未实现，以下能力已为迁移准备好：

- `ProjectExport`（`/v1/export`、`/api/projects/:id/export`）与 `/v1/import`（1k/批、去重）
- 幂等键（迁移/重放不产生重复记忆）
- 审计与维护记录（迁移窗口可追溯）
- 备份/恢复演练（`scripts/backup-restore-drill.sh`）
- 指标与告警（容量与延迟可量化）

> 下一步：从 Phase 0 开始。需要先确认目标 Postgres 版本（≥15，建议 16）与是否允许停写窗口（或使用 outbox 回放）。
