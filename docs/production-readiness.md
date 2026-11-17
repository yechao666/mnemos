# 生产就绪度（v6.1）

> 适用范围：Mnemos v6.1 单节点部署。配套：[架构](architecture.md) · [运维](operations.md) ·
> [安全](security.md) · [可观测性](observability.md) · [百万级与压测](v6-scale.md)。

## 1. 结论摘要

v6.1 已具备**单节点生产运行**的骨架：分区 + 人模型、游标 API、控制台、组织/分区密钥、
审计与用量、维护与备份、简报/上下文/做梦、混合检索、记忆历史/反馈、画像/生命周期、
实体图、多模态附件、PII/可选加密、DSH 插件与多语言 SDK。当前范围**不含**多副本、Postgres、
ANN/外置向量库、OIDC/SSO。

## 2. 成熟度矩阵

### P0 — 生产运行必备（v6 已落地）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| schema v7 + 迁移 | ✅ | 空库自动建；v6 库幂等升级 v7；检测到 v5 库拒绝启动；`schema_version=7` |
| 分区 / 人 / 记忆 API | ✅ | `/v1/partitions/...`，游标分页，无 total/COUNT(*) |
| 控制台 | ✅ | 组织 → 分区 → 人 → 记忆；人列表虚拟滚动 |
| 鉴权 | ✅ | 控制台会话 + 分区/组织 API Key；作用域/限流/过期/IP 白名单 |
| 多租户隔离 | ✅ | 所有查询带 `partition_id`；越权 404 |
| 计数与统计 | ✅ | 触发器维护 `partition_stats` 与 persons 计数；reconcile 兜底 |
| 简报 / 上下文 / 做梦 | ✅ | 人级 + 分区级；可选 LLM；离线确定性回退 |
| 审计 / 用量 | ✅ | 登录、密钥、分区/人/记忆写、做梦、维护、账号 |
| 备份 / 恢复 | ✅ | `VACUUM INTO` 在线备份，保留 14 份，admin API |
| 维护任务 | ✅ | 过期/保留期归档、软删除清理、会话清理、WAL checkpoint |
| 探针 / 指标 | ✅ | `/healthz` `/readyz` `/health` `/metrics` |
| 优雅停机 | ✅ | SIGTERM → drain → checkpoint → close |
| 规模脚本 | ✅ | `seed-scale` / `perf-persons`；10 万人实测预算全达标 |
| 混合检索 / 历史反馈 | ✅ | 候选 ≤700 + 内存 cosine；`hits/signals`；`memory_history`/`memory_feedback` |
| 画像 / 生命周期 | ✅ | facts 版本化 + 画像缓存；merge/archive/export/delete（软/硬） |
| 图 / 附件 / 合规 | ✅ | entities/relations + `/graph`；附件 URL/caption；PII basic；可选 AES-256-GCM |
| 异步写管线 | ✅ | `memory_jobs` worker（1s tick、重试、崩溃恢复）；`backfill:embeddings` |
| 评测门禁 | ✅ | `pnpm eval` 7 场景 / 38 checks |
| DSH 插件 / SDK / MCP | ✅ | DSH 8 工具、TS/Python SDK、MCP server、LangChain 适配 |

### P1 — 上生产前建议补齐

| 项 | 状态 | 说明 |
| --- | --- | --- |
| v6 运维脚本 | ✅ | `seed-scale.ts` / `perf-persons.ts` / `preflight.ts` 已提供；v5 旧脚本已删除 |
| Docker 镜像验证 | ⚠️ | Dockerfile 已写但本机无 Docker，未真机构建/运行/健康检查 |
| 备份加密 / 定时备份 | ⚠️ | 应用不加密备份、无内置 cron；需外部加密与调度 |
| 密钥集中管理 | ⚠️ | 仅控制台创建/轮换/吊销；无 KMS/Vault 集成 |
| 审计外送 | ⚠️ | 仅落库 + 控制台查看；建议外送 SIEM |
| 账号体系 | ❌ | 无 OIDC/SSO/SCIM、无 MFA |
| 压测覆盖 | ⚠️ | 只覆盖读路径（`perf-persons`）；写并发/长稳未做 |

### P2 — 规模化与组织级能力

- Postgres/读写分离、无状态多副本（当前 SQLite 单写者）。
- ANN / 外置向量库（当前本地 hash-384 + 候选集内存 cosine，适合单分区百万级记忆以内）。
- 多区域、跨租户配额计费、精细 RBAC（当前仅组织角色）。

## 3. SLO / 性能预算

| 指标 | 目标 |
| --- | --- |
| 可用性（单节点） | 月度 ≥ 99.5%（计划内维护不计） |
| 5xx 比例 | < 0.5%（告警阈值 2%，见 observability.md） |
| 人列表（1M 分区，limit 50）p95 | < 100ms |
| 人搜索（前缀）p95 | < 300ms |
| `GET stats` | < 10ms |
| 人详情 | < 20ms |
| 记忆列表（limit 50）p95 | < 100ms |
| 控制台首屏 / 滚动加载 50 行 | < 1s / < 200ms |

10 万人分区实测（本机）：列表 p95 4ms、搜索 13ms、stats 1ms、详情 <1ms。详见
[v6-scale.md](v6-scale.md)。

## 4. 容量估算

| 数据 | 占用（约） |
| --- | --- |
| 10 万人 + 2 万条记忆 | 109MB |
| 100 万人 | 1.0–1.2GB |
| 每条记忆 | ~0.25KB（含 FTS，随正文增长） |

- 内存：1M 人库建议 ≥2GB RAM；WAL 峰值按写入并发预留。
- CPU：读路径是索引点查；写路径串行。
- 单库文件建议 < 50GB；再大按分区拆分或归档。

## 5. 发布与回滚

1. 备份：`POST /api/ops/backup`。
2. 预检：`MNEMOS_DATA_DIR=data-v6 node scripts/preflight.ts`。
3. 验证：`pnpm typecheck && pnpm test && pnpm build`（CI 同款）。
4. 停服 / 部署 / 启动：`SIGTERM` → 替换代码或镜像 → 启动（自动补 schema）。
5. 验证：`/readyz`、`/health`、控制台登录、关键列表/搜索、`/metrics`。
6. 回滚：停新版本 → 回退代码/镜像 → 如 schema 已变更，先恢复升级前备份。

详细命令见 [operations.md](operations.md)「升级与回滚」。

## 6. 上线检查清单

- [ ] `MNEMOS_DEMO=0`；删除/吊销演示组织与演示密钥
- [ ] `MNEMOS_BOOTSTRAP_*` 创建初始 owner，随后改密并移除明文密码
- [ ] 反代终止 TLS，只监听 `127.0.0.1`；生产开 HSTS；`MNEMOS_TRUST_PROXY=1`
- [ ] 探针/指标只对内网开放
- [ ] 数据/备份目录 0700；备份加密与异地副本
- [ ] 外部定时备份 + 每月恢复演练
- [ ] 按业务分区创建最小作用域 Key（限流/过期/IP 白名单）
- [ ] 组织角色最小化；owner 仅用于管理组织密钥
- [ ] 确认 `/metrics` 抓取与告警规则（删除遗留 Webhook 规则）
- [ ] 跑一次 `perf-persons`（预发、接近真实数据量）
- [ ] 安全基线（[security.md](security.md) 第 7 节）通过
- [ ] 记录发布版本、schema_version、备份文件名与回滚点

## 7. 验证状态（当前工作区）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 0 error（server + web） |
| `pnpm test` | ✅ 40 tests / 0 fail |
| `pnpm build` | ✅ web/dist 构建通过 |
| 10 万人 seed + API 压测 | ✅ 预算全部达标（见 v6-scale.md） |
| 文档 curl/JSON 核对 | ✅ 对临时 v6 实例（/tmp 数据、独立端口）实际请求核对 |
| Docker 镜像 | ❌ 未验证（本机无 Docker） |
| v6 运维脚本 | ❌ 未适配（仍是 v5 脚本） |
