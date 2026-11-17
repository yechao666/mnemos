# 生产就绪度评估

> 评估对象：Mnemos 单节点生产部署（Node 原生 TS + SQLite WAL）。
> 本文给出成熟度矩阵、SLO、容量估算、发布/回滚流程、故障演练与数据保留策略，并明确标注**已验证**与**未验证**项。

---

## 1. 结论摘要

- **单节点生产可上线**：核心记忆 API、控制台、多租户隔离、审计、限流、登录锁定、配额、维护、备份/恢复、指标/探针、结构化日志、幂等、导入导出、OpenAPI 均已落地。
- **不建议**在未完成下列事项前承载关键业务：自动备份与异地副本、告警值班、OIDC（如企业要求 SSO）。
- 当前不具备高可用能力（SQLite 单写、单进程），可用性目标应按 **99.5%/月** 设定，而非 99.9%。
- Docker 镜像与 Compose 已按生产规范编写，但**本机没有 Docker，未做真实构建/运行验证**；CI 中 docker job 仅做语法与依赖验证。

---

## 2. 成熟度矩阵

图例：✅ 已完成并验证（本地/脚本）· ⚠️ 已完成但未在本机真机验证 · ⏳ 待做

### P0 — 生产运行必备（当前范围）

| 能力 | 状态 | 说明 / 验证方式 |
| --- | --- | --- |
| 结构化日志 | ✅ | JSON 输出、`requestId`、敏感字段脱敏；`MNEMOS_LOG_FORMAT=json` |
| 指标体系 | ✅ | `/metrics` Prometheus 文本；请求计数/延迟直方图/SSE/限流/鉴权失败 |
| 存活/就绪探针 | ✅ | `/healthz`（进程存活）、`/readyz`（DB/schema/引擎，失败 503） |
| 登录锁定 | ✅ | 连续 5 次失败锁定 15 分钟（423）；登录接口 30 次/分钟/IP（429） |
| 配额与保留期 | ✅ | 项目月 token 配额（429 + `Retry-After`）；`retentionDays` 归档 |
| 维护任务 | ✅ | 过期归档、保留期归档、软删清理、幂等/会话清理、WAL checkpoint、可选 VACUUM |
| 备份 / 恢复 API | ✅ | `POST /api/ops/backup`、列表/下载；`scripts/backup-restore-drill.sh` 17/17 PASS |
| 组织成员 API | ✅ | `/api/org/users*`：列表/创建/改角色/禁用/重置密码/删除（含 owner 保护） |
| 幂等键 | ✅ | `Idempotency-Key` + `x-idempotent-replayed`；安全基线检查覆盖 |
| OpenAPI | ✅ | `/openapi.json`、`/api/openapi.json`（OpenAPI 3.1） |
| 导入 / 导出 | ✅ | `/v1/export`、`/v1/import`（单次导入 ≤1000 条）、控制台项目导入导出 |
| 安全响应头 | ✅ | CSP/XFO/nosniff/Referrer-Policy/Permissions-Policy/COOP/CORP；HSTS 可选 |
| 安全基线检查 | ✅ | `scripts/security-check.mjs` 11/11 PASS（一次性实例） |
| 启动预检 | ✅ | `scripts/preflight.sh`：Node/目录/端口/DB 完整性/磁盘 |
| 压测脚本 | ✅ | `scripts/load-test.mjs`：RPS/p50/p95/p99/错误率，阈值退出码 |
| CI | ✅ | 类型检查、单测、构建、冒烟、安全基线、Docker build（语法） |
| 容器化 | ⚠️ | 多阶段、非 root、HEALTHCHECK、STOPSIGNAL；**未在本机验证** |
| 优雅停机 | ✅ | SIGTERM → 停新连接 → drain SSE/in-flight → WAL checkpoint → 关闭 |

### P1 — 上生产前应补齐（按优先级）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 首次部署管理员引导 | ✅ | 空库 + `MNEMOS_DEMO=0` 时通过 `MNEMOS_BOOTSTRAP_EMAIL/PASSWORD` 创建初始 owner；缺少配置会拒绝启动 |
| 自动备份调度 + 异地加密 | ⏳ | 当前仅手动/API/cron 外部触发；无内置定时备份与加密上传 |
| 告警与值班 | 🟡 | 已提供 Grafana 面板与 Prometheus 告警规则（`deploy/`）；Alertmanager 路由与值班表由部署方接 |
| OIDC / SSO + SCIM | ⏳ | 目前仅本地账号；企业 SSO 与成员同步未实现 |
| Webhook 事件外送 | ✅ | HMAC-SHA256 签名、指数退避重试、死信、投递日志/重放、SSRF 防护、控制台与 v1 API |
| Postgres / 外部存储 | ⏳ | 单写限制并发与容量；存储接缝与分阶段方案见 [`scaling.md`](scaling.md)（当前仅 `MNEMOS_STORAGE=sqlite`） |
| 多副本 / HA | ⏳ | 单进程单库；演进计划见 [`scaling.md`](scaling.md)（Phase 2/3） |
| OpenTelemetry 链路追踪 | ✅ | OTLP/HTTP 导出、手动 server span、traceId 注入响应与日志、Grafana/告警模板 |
| 镜像签名/SBOM/漏洞扫描 | ⏳ | CI 未接 Trivy/Grype/Cosign |
| 密钥管理集成 | ⏳ | 依赖环境变量/外部 Secret；未接 Vault/KMS |
| 官方 SDK（TS/Python） | ✅ | `sdk/typescript`（13 测试）与 `sdk/python`（13 测试），覆盖 v1 全部资源与重试/幂等 |
| 发布审批与变更记录 | ⏳ | 目前靠流程约定 |

### P2 — 规模化与组织级能力

| 能力 | 说明 |
| --- | --- |
| 自动扩缩容 | 单节点无状态化之前不可行；需先做存储外置 + 会话共享 |
| 多区域部署 | 数据主权/容灾需求；需跨区复制与冲突解决 |
| 读写分离 / 只读副本 | SQLite 下可用备份只读副本，但不是实时复制 |
| 分片 / 多租户集群 | 按组织分库/分片，需路由层与迁移工具 |
| 灰度 / 金丝雀发布 | 单节点可做维护窗口发布；蓝绿需要双实例共享存储 |
| 数据生命周期自动化 | 冷热分层、归档到对象存储 |

---

## 3. SLO

> 单节点、无 HA 的保守目标；以 Prometheus 指标与 `/metrics` 为准。

| SLI | 目标 | 度量 |
| --- | --- | --- |
| 可用性 | **99.5% / 月**（允许停机约 3h39m） | `/readyz` 探测成功率（1 分钟粒度） |
| 检索延迟 | p95 ≤ **200ms**、p99 ≤ 500ms（单项目 ≤1 万条记忆） | `mnemos_http_request_duration_milliseconds{route="/api/projects/:id/memories"}` |
| 写入延迟 | p95 ≤ **300ms** | 同上 `POST /v1/memories` |
| 错误率 | 5xx < **0.5%**（5 分钟窗口） | `mnemos_http_requests_total{status=~"5.."}` |
| 限流/配额拒绝 | 可观测，不纳入错误率 | `mnemos_rate_limited_total`、`quota_exceeded` 日志 |
| RPO | **≤ 1 小时**（推荐每小时备份；当前需外部 cron） | 备份时间戳 |
| RTO | **≤ 30 分钟**（含恢复 + 就绪验证） | 恢复演练记录 |

> 延迟指标已统一为 `mnemos_http_request_duration_milliseconds`（单位毫秒，桶 5…2500ms），可直接用 `histogram_quantile()` 并除以 1000 得到秒。

参考实测（演示数据集，约 250 条记忆，4 并发、3 秒）：

```
请求总数 1173 · RPS 383.4 · p50 9.1ms · p95 24.5ms · p99 36.3ms · 错误率 0%
```

该数据仅用于本机基线，不能外推为生产承诺；上线前请用实际数据量 + 真实并发重跑 `load-test.mjs`。

**99.9% 不可达的原因**：单进程、单 SQLite 写库、无自动故障转移；维护/升级/主机故障都会造成分钟级中断。

---

## 4. 容量估算

### 4.1 存储

| 数据量 | 估算 DB 大小 | 说明 |
| --- | --- | --- |
| 1 万条记忆 | 30–80 MB | 384 维向量约 1.5KB/条 + 内容 + 词项/实体 |
| 10 万条 | 300–800 MB | 检索为暴力向量扫描，p95 随候选集线性上升 |
| 100 万条 | 3–8 GB | 建议按项目归档/分库；单项目不宜超过 10 万条 |
| 用量/审计 | 每请求约 0.2–0.5 KB | 100 万请求/月 ≈ 200–500 MB/月，需定期清理 |

- WAL 峰值：写入突发时可达数十 MB；维护任务会 checkpoint。
- 备份空间：保留 14 份 × DB 大小。1 GB 库约需 14 GB 备份空间，另加异地副本。
- 磁盘余量建议 ≥ 30%（预检阈值 1GB 只是最低线）。

### 4.2 内存 / CPU

| 规模 | 建议 |
| --- | --- |
| 演示/小团队（≤1 万条，≤5 QPS） | 1 vCPU / 512 MB |
| 中等（≤10 万条，≤20 QPS） | 2 vCPU / 1–2 GB |
| 大（>10 万条或高并发） | 先评估迁移 Postgres/外部向量库；单机纵向扩容收益有限 |

Node 进程基线约 60–100 MB RSS；向量检索为 CPU 密集型，并发搜索会推高 p95。

### 4.3 关键瓶颈

1. **SQLite 单写**：所有写操作串行；写多场景吞吐受限于 WAL fsync。
2. **暴力向量扫描**：候选集越大，检索越慢；需按项目/可见性收窄。
3. **单进程 CPU**：Node 单线程处理请求；多核机器无法自动利用（可后续用 cluster/多实例 + 只读副本）。
4. **备份 I/O**：`VACUUM INTO` 会读全库；建议低峰执行。

---

## 5. 发布与回滚

### 5.1 发布前

```bash
# 1) 环境预检（在目标机执行）
bash scripts/preflight.sh

# 2) 备份（admin 会话）
bash scripts/backup-restore-drill.sh   # 同时验证备份可恢复

# 3) 本地/CI 验证
pnpm verify
node scripts/smoke-api.mjs
node scripts/security-check.mjs --auto-start --base http://127.0.0.1:4392

# 4) 压测（预发，真实数据量）
node scripts/load-test.mjs --base http://127.0.0.1:4380 --concurrency 16 --duration 30
```

### 5.2 发布（单节点维护窗口）

```bash
# 停止旧进程（SIGTERM，等待优雅停机）
kill -TERM <pid>

# 部署新代码/镜像
pnpm install --frozen-lockfile && pnpm build   # 或 docker compose up -d --build

# 启动新进程
node server/src/main.ts

# 验证
curl -fsS http://127.0.0.1:4380/readyz | jq -e '.ok == true'
node scripts/smoke-api.mjs
```

- schema 迁移在启动时自动执行（幂等 `CREATE TABLE IF NOT EXISTS` + 版本迁移），**只向前、不提供 down migration**。
- 升级前必须备份；若新版本迁移失败，进程启动即退出（`assertEnv` / 迁移异常）。

### 5.3 回滚

```bash
# 1) 停止新版本
kill -TERM <pid>

# 2) 回退代码/镜像到上一版本
# 3) 恢复数据库到升级前备份（重要：schema 可能已被新版本修改）
cp /path/to/backup/mnemos-<ts>-manual.db data/mnemos.db
rm -f data/mnemos.db-wal data/mnemos.db-shm

# 4) 启动旧版本并验证
node server/src/main.ts
curl -fsS http://127.0.0.1:4380/readyz
```

注意事项：

- 恢复后，备份点之后的写入会丢失；若新旧版本 schema 兼容，可优先只回退代码而不恢复数据（需评估迁移是否破坏兼容）。
- 回滚操作必须记录到变更单，并核对审计/告警。

---

## 6. 故障演练

| 演练 | 方法 | 期望 | 频率 |
| --- | --- | --- | --- |
| 进程崩溃恢复 | `kill -9 <pid>` 后重启 | WAL 自动恢复；`/readyz` 200；数据不丢已提交事务 | 每月 |
| 备份恢复 | `bash scripts/backup-restore-drill.sh` | 17/17 PASS；恢复实例可查询 | 每月 |
| 磁盘写满 | 临时占满分区（测试环境） | 写入失败有明确 5xx；维护/备份不破坏主库；清理后恢复 | 每季度 |
| 端口占用 | 占用 4380 后启动 | `preflight.sh` FAIL；启动失败有清晰报错 | 变更前 |
| 密钥轮换 | 控制台轮换 + 宽限期 | 旧密钥到期失效、新密钥可用；审计完整 | 每季度 |
| 登录锁定 | 连续 5 次错误密码 | 423 锁定；15 分钟后自动解锁 | 每次安全基线 |
| 反向代理 502 | 停服务后访问 | 网关返回 502；恢复后自愈；告警触发 | 每季度 |
| 大导入 | 导入 1000 条记忆 | 成功/部分失败有明细；请求不超时 | 版本发布前 |
| 时钟漂移 | 调整系统时间（测试机） | 会话过期/审计时间符合预期；NTP 告警 | 每半年 |

演练记录至少包含：时间、执行人、命令、结果、发现的问题与修复项。

---

## 7. 数据保留与备份策略

### 7.1 保留

- 项目级 `settings.retentionDays`（默认 365）：维护任务将过期记忆转为 `archived`。
- 软删除记忆：30 天后物理清理（维护任务分批删除）。
- 幂等键、过期会话：维护任务定期清理。
- 审计日志/用量事件：默认不自动删除；按合规要求定期归档到 SIEM/数仓后清理。
- 建议：财务/法务要求的数据单独标记，避免被保留期策略误归档。

### 7.2 维护任务

- 自动：进程启动 60s 后首次执行，之后每 `MNEMOS_MAINTENANCE_INTERVAL_MIN`（默认 360 分钟）。
- 手动：`POST /api/ops/maintenance`（admin+），支持 `dryRun` 与 `vacuum`。
- 历史：`GET /api/ops/maintenance?limit=20`。
- VACUUM 会短暂阻塞写；建议低峰、且磁盘有 ≥2× 库大小的空闲空间。

### 7.3 备份

| 项 | 建议 |
| --- | --- |
| 频率 | 每小时（外部 cron 调用 `POST /api/ops/backup` 或 `VACUUM INTO`） |
| 保留 | 应用内保留 14 份；异地保留 30–90 天（按合规） |
| 加密 | 应用不加密；上传对象存储前用 age/GPG/KMS 加密 |
| 异地 | 至少一份离线/异地域副本 |
| 演练 | 每月恢复演练，记录 RTO |
| 监控 | 备份失败/过期无新备份 → 告警 |

示例 cron（在宿主机，使用服务账号会话或直接 `VACUUM INTO`）：

```bash
# 每天 03:15 通过 API 备份（需先获取 admin 会话；示例为演示环境）
15 3 * * * cd /opt/mnemos && \
  TOKEN=$(curl -s -X POST http://127.0.0.1:4380/api/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"ops@example.com","password":"***"}' | jq -r .token) && \
  curl -s -X POST http://127.0.0.1:4380/api/ops/backup \
    -H "authorization: Bearer $TOKEN" >/var/log/mnemos-backup.log 2>&1
```

> 生产不建议把密码写进 cron；应由密钥管理/受限脚本提供短期凭据，或直接以服务用户执行 `sqlite3 data/mnemos.db "VACUUM INTO '/backup/mnemos-$(date +%F).db'"`。

---

## 8. 上线检查清单

- [ ] 反向代理终止 TLS，仅监听回环/内网；`MNEMOS_HOST=127.0.0.1`；开启 HSTS（`MNEMOS_HSTS=1`）前确认全站 HTTPS
- [ ] `MNEMOS_DEMO=0`；删除/禁用演示账号，吊销全部 `mnemos_live_demo_*` 密钥
- [x] 完成管理员引导（`MNEMOS_BOOTSTRAP_*`，空库启动自动创建 owner）
- [ ] 数据目录/备份目录权限 700，属主为服务用户；磁盘余量 ≥30%
- [ ] 备份：定时任务 + 异地加密副本 + 恢复演练通过
- [ ] 监控：Prometheus 抓取 `/metrics`；`/readyz` 黑盒探测；告警规则（5xx、p95、429、磁盘、备份）
- [ ] 日志：采集 stdout（JSON）；保留期与访问控制；敏感字段复核
- [ ] 安全基线：`security-check.mjs` 全 PASS；`preflight.sh` 全 PASS
- [ ] 压测：以真实数据量与并发达到 SLO；记录容量余量
- [ ] 发布/回滚流程演练；备份可恢复
- [ ] 变更记录、值班人与升级路径明确
- [ ] 合规：数据保留期、审计保留、跨境/隐私要求确认

---

## 9. 验证状态（如实记录）

| 项 | 状态 |
| --- | --- |
| 脚本语法 | ✅ `bash -n` ×2、`node --check` ×2 通过 |
| preflight | ✅ 本机运行通过（备份目录缺失/端口占用场景正确 FAIL） |
| 安全基线 | ✅ 最新工作区一次性实例 11/11 PASS |
| 备份/恢复演练 | ✅ 17/17 PASS（API 备份 → integrity → 计数比对 → migrate → 4398 恢复实例 → 查询项目） |
| 压测 | ✅ 演示数据 3s/4 并发：RPS 383.4、p95 24.5ms、0 错误（参考值） |
| CI YAML / Compose YAML | ✅ 语法解析通过 |
| Docker 镜像构建 | ❌ **本机无 Docker，未验证**；CI 仅 `docker build` 语法验证 |
| 容器运行 / HEALTHCHECK | ❌ 未验证 |
| GitHub Actions 实际执行 | ❌ 未在 CI 平台运行（工作区未推送） |
| 真实反向代理 / TLS | ❌ 未验证 |
| 生产规模容量 | ❌ 仅演示数据；需按实际数据重测 |
| OIDC / webhook / Postgres / 多副本 / OTel | ❌ 未实现 |

> 结论：**单节点部署可进入预发与受控生产**；Docker 路径在具备 Docker 的环境完成一次“构建 → 运行 → 健康检查 → 备份恢复”后，再标记为已验证。
