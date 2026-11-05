# 运维手册

> 配套文档：[安全模型](security.md) · [生产就绪度](production-readiness.md) · [API 参考](api.md)
> 脚本：`scripts/preflight.sh`、`scripts/load-test.mjs`、`scripts/backup-restore-drill.sh`、`scripts/security-check.mjs`

---

## 1. 运行要求

- Node.js ≥ 22.18（推荐 24/26；原生执行 TypeScript，无需构建服务端）
- 单机 1 vCPU / 512 MB 可运行；演示数据集约 5 MB
- 无外部依赖：SQLite 通过 `node:sqlite` 内置，无需安装数据库
- 可用 `sqlite3` 命令行做排障（可选；缺失时脚本回退 `node:sqlite`）

## 2. 启动

```bash
# 首次部署：准备目录（预检要求备份目录已存在）
mkdir -p data data/backups
chmod 700 data

# 预检：Node 版本 / 目录可写 / 端口 / DB 完整性 / 磁盘
bash scripts/preflight.sh

pnpm install --frozen-lockfile
pnpm build            # 构建控制台（web/dist），仅首次或前端变更后
pnpm start            # 读取环境变量并启动（默认 127.0.0.1:4380）
```

生产建议用进程守护（含最小权限加固）：

```ini
# /etc/systemd/system/mnemos.service
[Unit]
Description=Mnemos Memory Infrastructure
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mnemos
Environment=NODE_ENV=production
Environment=MNEMOS_HOST=127.0.0.1
Environment=MNEMOS_PORT=4380
Environment=MNEMOS_DATA_DIR=/var/lib/mnemos
Environment=MNEMOS_BACKUP_DIR=/var/lib/mnemos/backups
Environment=MNEMOS_LOG_FORMAT=json
EnvironmentFile=-/etc/mnemos/mnemos.env
ExecStart=/usr/bin/node server/src/main.ts
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
User=mnemos
Group=mnemos
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mnemos

[Install]
WantedBy=multi-user.target
```

反向代理（Nginx，TLS 终止 + SSE 不缓冲）：

```nginx
server {
  listen 443 ssl http2;
  server_name memory.example.com;

  location / {
    proxy_pass http://127.0.0.1:4380;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
  }

  # SSE 需要关闭缓冲
  location /api/events {
    proxy_pass http://127.0.0.1:4380;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
  }

  # 运维端点只允许内网
  location ~ ^/(metrics|healthz|readyz)$ {
    allow 10.0.0.0/8;
    allow 127.0.0.1;
    deny all;
    proxy_pass http://127.0.0.1:4380;
  }
}
```

> 单节点无法热发布；升级需短维护窗口。容器部署见 `Dockerfile` / `docker-compose.yml`（本机无 Docker，未真机验证）。

## 2.5 首次启动（生产模式）

`MNEMOS_DEMO=0` 且数据库没有用户时，必须提供初始管理员，否则进程会拒绝启动：

```bash
MNEMOS_DEMO=0 \
MNEMOS_BOOTSTRAP_EMAIL=admin@example.com \
MNEMOS_BOOTSTRAP_PASSWORD='ChangeMe-12345' \
MNEMOS_BOOTSTRAP_NAME='平台管理员' \
MNEMOS_BOOTSTRAP_ORG_NAME='我的组织' \
pnpm start
```

首次启动会创建组织与 owner；登录后请立即在控制台修改密码（用户菜单 → 修改密码），并移除环境变量中的明文密码。之后重启不再需要这些变量。

## 3. 配置项

完整示例见 `.env.example`。生产要点：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MNEMOS_HOST` | `127.0.0.1` | 生产只监听回环，由反代暴露 |
| `MNEMOS_PORT` | `4380` | 监听端口 |
| `MNEMOS_DATA_DIR` | `./data` | 数据目录（权限 700） |
| `MNEMOS_DB_PATH` | `$DATA_DIR/mnemos.db` | SQLite 路径 |
| `MNEMOS_BACKUP_DIR` | `$DATA_DIR/backups` | 备份目录（需可写） |
| `MNEMOS_DEMO` | `1` | **生产设 0**，禁止空库自动写入演示数据 |
| `MNEMOS_AUTH_DISABLED` | `0` | 仅本机调试；生产环境启动会直接拒绝 |
| `MNEMOS_SESSION_TTL_HOURS` | `72` | 控制台会话有效期 |
| `MNEMOS_LOGIN_MAX_ATTEMPTS` | `5` | 连续失败锁定阈值 |
| `MNEMOS_LOGIN_LOCK_MINUTES` | `15` | 锁定时长 |
| `MNEMOS_LOG_LEVEL` | `info` | debug/info/warn/error |
| `MNEMOS_LOG_FORMAT` | 生产 `json` | json/pretty |
| `MNEMOS_METRICS_ENABLED` | `1` | 关闭时 `/metrics` 返回 404 |
| `MNEMOS_TRUST_PROXY` | `0` | 反代后设 1，使用 `X-Forwarded-For` 取真实 IP |
| `MNEMOS_HSTS` | `0` | 全站 HTTPS 后设 1 |
| `MNEMOS_QUOTA_ENFORCE` | `1` | 项目月配额强制 |
| `MNEMOS_REQUEST_TIMEOUT_MS` | `30000` | 请求超时（SSE 豁免） |
| `MNEMOS_SHUTDOWN_TIMEOUT_MS` | `10000` | 优雅停机等待上限 |
| `MNEMOS_MAINTENANCE_INTERVAL_MIN` | `360` | 维护任务间隔（分钟） |
| `MNEMOS_BODY_LIMIT_BYTES` | `1048576` | 请求体上限（1MB） |
| `MNEMOS_LLM_*` | 空 | 可选模型抽取/嵌入；不配置则离线运行 |

启动时 `assertEnv` 会校验：生产禁止 `AUTH_DISABLED`、数据/备份目录可写、端口/超时/日志级别合法；不通过直接退出（避免半可用状态）。

## 4. 数据与备份

### 4.1 文件布局

- 数据库：`$MNEMOS_DATA_DIR/mnemos.db`（伴随 `-wal`、`-shm`）。
- 备份：`$MNEMOS_BACKUP_DIR/mnemos-<时间戳>-<kind>.db`（kind: `manual` / `scheduled` / `preflight`），默认保留最近 **14** 份。
- 不要手工删除 `-wal/-shm`，除非在停服务恢复场景。

### 4.2 在线备份

推荐用运维 API（admin+，`VACUUM INTO`，不锁库）：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4380/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"lin.wei@mnemos.dev","password":"mnemos-demo"}' | jq -r .token)

# 触发备份
curl -s -X POST http://127.0.0.1:4380/api/ops/backup \
  -H "authorization: Bearer $TOKEN" | jq .
# → {"id":"bkp_…","file":"mnemos-20261105-150000-manual.db","sizeBytes":…,"createdAt":"…","kind":"manual"}

# 列表 / 下载
curl -s http://127.0.0.1:4380/api/ops/backups -H "authorization: Bearer $TOKEN" | jq .
curl -fsS -OJ http://127.0.0.1:4380/api/ops/backups/mnemos-20261105-150000-manual.db \
  -H "authorization: Bearer $TOKEN"
```

无 API / 手工兜底：

```bash
sqlite3 data/mnemos.db ".backup '/backup/mnemos-$(date +%F).db'"
# 或
sqlite3 data/mnemos.db "VACUUM INTO '/backup/mnemos-$(date +%F-%H%M).db';"
```

### 4.3 恢复

```bash
# 1) 停服务（SIGTERM，优雅停机）
kill -TERM <pid>

# 2) 保留现场（排障用，随后再删）
cp data/mnemos.db /var/tmp/mnemos-before-restore.db

# 3) 替换并清理 WAL
cp /backup/mnemos-20261105-150000-manual.db data/mnemos.db
rm -f data/mnemos.db-wal data/mnemos.db-shm

# 4) 启动并验证
node server/src/main.ts
curl -fsS http://127.0.0.1:4380/readyz | jq -e '.ok == true'
```

### 4.4 恢复演练（强烈建议每月）

```bash
# 对运行中的服务：API 备份 → 完整性/计数校验 → 迁移器演练 → 4398 临时实例恢复查询
bash scripts/backup-restore-drill.sh

# 自定义目标/源库
MNEMOS_BASE=http://127.0.0.1:4380 \
MNEMOS_DATA_DIR=/var/lib/mnemos \
MNEMOS_BACKUP_DIR=/var/lib/mnemos/backups \
DRILL_PORT=4398 \
bash scripts/backup-restore-drill.sh
```

脚本不会修改 `data/`；临时数据在系统临时目录，结束自动清理。API 未上线时自动回退 `VACUUM INTO` 并标记 SKIP。

### 4.5 演示数据

`pnpm seed`（`--force` 会清空全部数据）仅用于演示环境，生产禁用。

## 5. 健康检查与探针

| 端点 | 鉴权 | 用途 | 就绪判定 |
| --- | --- | --- | --- |
| `GET /healthz` | 无 | 进程存活（liveness） | 200 + `ok=true` |
| `GET /readyz` | 无 | 就绪（DB / schema / 引擎） | 200 + `ok=true`；不满足 503 |
| `GET /api/health` | 无 | 详细健康（版本/uptime/DB/引擎） | 200 |
| `GET /metrics` | 无（内网） | Prometheus 指标 | 200 text/plain |
| `GET /openapi.json` | 无 | OpenAPI 3.1 文档 | 200 |
| `GET /v1/health` | 无 | 兼容探针 | 200 |
| `GET /api/projects/{id}/overview` → `health.checks` | 会话 | 项目级依赖检查 | 200 |

探针建议：

```bash
# liveness（进程存活；不要用 /readyz 做 liveness，避免启动期被杀）
curl -fsS http://127.0.0.1:4380/healthz | jq -e '.ok == true'

# readiness（DB/schema/引擎）
curl -fsS http://127.0.0.1:4380/readyz | jq -e '.ok == true'

# Prometheus 抓取
curl -fsS http://127.0.0.1:4380/metrics | head
```

Kubernetes 探针参数建议（如未来容器化）：

- liveness：`/healthz`，`initialDelaySeconds: 10`，`periodSeconds: 10`，`failureThreshold: 3`
- readiness：`/readyz`，`initialDelaySeconds: 5`，`periodSeconds: 5`，`failureThreshold: 3`

## 6. 可观测性

### 6.1 结构化日志

生产默认 JSON（`MNEMOS_LOG_FORMAT=json`），每行一条：

```json
{"ts":"2026-11-05T15:00:00.000Z","level":"info","msg":"http.request","method":"GET","path":"/api/projects/prj_orion_python/memories","status":200,"latencyMs":12,"requestId":"req_ab12","ip":"127.0.0.1","route":"/api/projects/:id/memories","actor":"lin.wei@mnemos.dev"}
```

| 字段 | 说明 |
| --- | --- |
| `ts` | ISO 8601 时间 |
| `level` | debug/info/warn/error |
| `msg` | 事件名（`http.request`、`http.request.slow`、`http.request.failed`、`http.request.exception`、`seed:*`、`backup.*`、`maintenance.*` 等） |
| `requestId` | 与响应头 `x-request-id` 一致，可全链路关联 |
| `method` / `path` / `status` / `latencyMs` | 访问日志核心字段 |
| `route` | 路由模板（低基数，用于指标/聚合） |
| `ip` | 客户端 IP（`MNEMOS_TRUST_PROXY=1` 时取 XFF） |
| `actor` | 用户邮箱或 `API Key · <name>` |
| `error` | 错误对象（name/message/stack/cause），5xx 时输出 |

- 敏感字段（authorization/password/apikey/secret/token/cookie/credential）自动替换为 `[REDACTED]`。
- 慢请求（>1s）记 `warn`；5xx 记 `error`。
- 日志写 stdout；容器使用 `json-file` 轮转（10MB × 5），宿主机交给 journald/采集器。

### 6.2 指标（`/metrics`）

| 指标 | 类型 | 标签 | 用途 |
| --- | --- | --- | --- |
| `mnemos_http_requests_total` | counter | method, route, status | QPS、错误率、状态码分布 |
| `mnemos_http_request_duration_milliseconds` | histogram | method, route | p50/p95/p99（单位毫秒，桶 5…2500ms，见下） |
| `mnemos_rate_limited_total` | counter | route | 限流触发 |
| `mnemos_quota_rejected_total` | counter | — | 配额拒绝 |
| `mnemos_auth_failures_total` | counter | — | 登录/鉴权失败 |
| `mnemos_auth_logins_total` | counter | result=success/failure | 登录结果 |
| `mnemos_timeouts_total` | counter | — | 请求超时 |
| `mnemos_sse_clients` | gauge | — | SSE 连接数 |
| `mnemos_uptime_seconds` | gauge | — | 进程 uptime |
| `mnemos_build_info` | gauge | version | 版本信息 |

> 延迟直方图单位是**毫秒**（桶 5/10/25/50/100/250/500/1000/2500）。指标名已明确为 `..._milliseconds`；`histogram_quantile()` 结果除以 1000 即秒。

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: mnemos
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:4380']
```

### 6.3 运维状态 API

```bash
# 运行状态快照：版本/uptime/DB 文件与 WAL 大小/schema/计数/配额/保留期/备份/维护/指标
curl -s http://127.0.0.1:4380/api/ops/status -H "authorization: Bearer $TOKEN" | jq .

# 手动维护（dryRun 只统计不写；vacuum 回收空间）
curl -s -X POST http://127.0.0.1:4380/api/ops/maintenance \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"dryRun": true}' | jq .

# 维护历史
curl -s "http://127.0.0.1:4380/api/ops/maintenance?limit=20" \
  -H "authorization: Bearer $TOKEN" | jq .
```

## 7. 维护任务

启动后 60s 首次执行，之后每 `MNEMOS_MAINTENANCE_INTERVAL_MIN`（默认 360 分钟）执行一次；也可通过 API 手动触发。

| 任务 | 行为 |
| --- | --- |
| 过期记忆归档 | 项目 `settings.retentionDays`（默认 365）之前的 `active` 记忆 → `archived` |
| 保留期归档 | 同上（按项目配置合并执行） |
| 软删除清理 | `status=deleted` 且超过 30 天的记忆物理删除（分批，每批 400） |
| 幂等键清理 | 超过 TTL 的 `idempotency_keys` 删除 |
| 会话清理 | 过期会话删除 |
| WAL checkpoint | `PRAGMA wal_checkpoint(TRUNCATE)`，回收 WAL 空间 |
| VACUUM（可选） | 只在手动 `{"vacuum": true}` 时执行；需 ≥2× 库大小空闲磁盘，且会阻塞写 |

注意事项：

- 维护在单事务内完成数据变更，checkpoint/VACUUM 在事务外执行。
- 失败不会中断调度器，但会在 `maintenance_runs` 记录 `failed` 并写日志/审计。
- `dryRun=true` 不产生数据变更，适合变更前评估影响面。
- 大库首次归档可能耗时较长，建议低峰执行并观察 `latencyMs` 与日志。

## 8. 密钥轮换与登录锁定

### 8.1 密钥轮换

```bash
# 创建新 Key（最小作用域；明文只返回一次）
curl -s -X POST http://127.0.0.1:4380/api/projects/prj_orion_python/keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"orion-api-v2","scopes":["memories:read","memories:write"],"rateLimitPerMin":600}' | jq .

# 轮换旧 Key：宽限 24h
curl -s -X POST http://127.0.0.1:4380/api/projects/prj_orion_python/keys/key_xxx/rotate \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"graceHours": 24}' | jq .

# 立即吊销
curl -s -X DELETE http://127.0.0.1:4380/api/projects/prj_orion_python/keys/key_xxx \
  -H "authorization: Bearer $TOKEN" | jq .
```

- 新 Key 继承 scopes、限流、过期时间、IP 白名单。
- `graceHours=0` 立即吊销旧 Key；>0 时旧 Key 到期自动失效。
- 密钥只存 SHA-256；创建/轮换响应中的 `secret` 是唯一一次明文。

### 8.2 登录锁定

- 连续 `MNEMOS_LOGIN_MAX_ATTEMPTS`（默认 5）次密码错误 → 账号锁定 `MNEMOS_LOGIN_LOCK_MINUTES`（默认 15 分钟），返回 **423**。
- 登录接口另有 30 次/分钟/IP 限流，超限返回 **429**（带 `Retry-After`）。
- 锁定状态存 `users.locked_until`，重启不丢失。解锁：

```bash
sqlite3 data/mnemos.db \
  "UPDATE users SET locked_until=NULL, failed_login_attempts=0 WHERE email='lin.wei@mnemos.dev';"
```

- 管理员重置成员密码：`POST /api/org/users/:id/reset-password`（返回一次性临时密码，并清理该用户会话）。
- 组织成员管理（admin+）：`GET/POST /api/org/users`、`PATCH /api/org/users/:id`（角色/状态/资料）、`DELETE /api/org/users/:id`（仅 owner）。

## 9. 升级与迁移

1. **备份**：`POST /api/ops/backup` 或 `bash scripts/backup-restore-drill.sh`（同时验证可恢复）。
2. **预检**：`bash scripts/preflight.sh`（升级前也建议跑一次）。
3. **部署**：拉取新代码/镜像，`pnpm install --frozen-lockfile && pnpm build`（或 `docker compose up -d --build`）。
4. **重启**：`SIGTERM` 旧进程 → 启动新进程。schema 迁移在启动时自动执行：
   - 幂等建表（`CREATE TABLE IF NOT EXISTS`）；
   - 列级变更由 `ensureColumns` 幂等补齐；
   - 版本迁移记录在 `meta.schema_version`，**只向前**。
5. **验证**：`/readyz`、冒烟 `node scripts/smoke-api.mjs`、关键查询、日志无异常。
6. **回滚**：
   - 代码回退 + 重启；
   - 若新版本已迁移 schema，回滚代码前先恢复升级前备份（`cp backup data/mnemos.db`，删除 `-wal/-shm`）；
   - 记录回滚原因与影响。

```bash
# 查看当前 schema 版本
sqlite3 -readonly data/mnemos.db "SELECT value FROM meta WHERE key='schema_version';"
```

> 本机当前 schema_version 为 2（`production-hardening`）。`/readyz` 会在 `schema_version < SCHEMA_VERSION` 时返回 503。

## 10. 容量与性能

- 记忆量 1 万条内：检索 p50 通常 10–40ms（单机、含向量暴力扫）。
- 索引体积估算：384 维向量 1.5KB/条 + 词项若干，万条约 30–80MB。
- 项目隔离在 SQL 层生效，单项目记忆量过大时可归档（`status=archived`）降低候选集。
- 写路径串行（SQLite 单写）；高并发写会推高 p95。
- 用量事件建议按月清理：`DELETE FROM usage_events WHERE created_at < ?`（保留审计与记忆历史）。
- 审计日志按合规要求保留，建议外送 SIEM。
- 压测：

```bash
# 默认 16 并发、10s，p95 > 500ms 或错误率 > 1% 退出码 1
node scripts/load-test.mjs

# 自定义
node scripts/load-test.mjs --base http://127.0.0.1:4380 \
  --concurrency 32 --duration 30 --mix 70:20:10 \
  --max-p95-ms 300 --max-error-rate 0.5%

# 跳过登录（使用已有会话）
node scripts/load-test.mjs --token "$TOKEN"
```

> 压测会对控制台搜索/列表产生 `usage_events`（正常业务写入），但不会写入/修改/删除记忆。请勿在生产高峰对主库压测。

## 11. 安全清单

- [ ] 关闭演示数据（`MNEMOS_DEMO=0`），删除演示账号
- [ ] 反向代理终止 TLS，只监听 `127.0.0.1`；生产开启 HSTS
- [ ] 吊销演示密钥 `mnemos_live_demo_*`
- [ ] 按业务项目分配最小作用域密钥，设置合理限流/过期/IP 白名单
- [ ] 定期轮换密钥（`rotate` + 宽限期）
- [ ] 备份文件加密存放；`data/` 目录权限 700
- [ ] `/metrics`、`/healthz`、`/readyz` 不对公网暴露
- [ ] 执行 `node scripts/security-check.mjs`，全 PASS 后上线
- [ ] 详细威胁模型与事件响应见 [security.md](security.md)

## 12. 常见告警与处理

| 告警 | 可能原因 | 处理 |
| --- | --- | --- |
| `ReadyzFailing`（503） | DB 打不开、schema 落后、引擎未初始化 | 查 `/readyz` 的 `checks` 字段与启动日志；确认迁移成功、磁盘可写、无锁库进程 |
| `HighErrorRate`（5xx > 0.5%） | DB locked、磁盘满、代码缺陷 | 用 `requestId` 关联日志；查 `database is locked`/`SQLITE_FULL`；清理磁盘或停写排查 |
| `HighLatency`（p95 > 500ms） | 候选集过大、并发过高、VACUUM/备份争 I/O | 查看 route 维度指标；归档/收窄过滤；低峰执行维护；扩容 |
| `AuthFailureSpike` | 撞库、密钥泄漏被滥用、客户端配置错误 | 查审计/日志 IP；临时封禁、调低限流、吊销/轮换密钥 |
| `RateLimitedSpike` | 调用方未退避、配额耗尽 | 检查 `X-RateLimit-*` 与 `Retry-After`；调整 Key 限流或项目配额 |
| `DiskSpaceLow` | WAL 增长、备份堆积、日志未轮转 | 清理旧备份（保留 14 份策略之外的手工副本）、checkpoint、扩容 |
| `BackupStale` | cron 失败、目录权限、磁盘满 | 手工 `POST /api/ops/backup` 验证；检查 `MNEMOS_BACKUP_DIR` 权限与磁盘 |
| `DBIntegrityFailed` | 磁盘损坏、非正常关机 | 停服务，从最近备份恢复；保留损坏库取证 |
| `SSEClientsHigh` | 客户端未断连/泄漏 | 检查控制台页面与反代超时；必要时重启进程（会断开 SSE） |
| `LoginLocked` | 连续密码错误 | 等待锁定窗口或管理员重置密码；排查撞库来源 |

## 13. 常见问题

| 现象 | 排查 |
| --- | --- |
| 控制台白屏 | 确认已 `pnpm build` 且 `web/dist` 存在；`curl -I /assets/…` |
| `/api` 401 | 会话过期（默认 72h），重新登录；或检查系统时间 |
| `/v1` 401 | Key 错误/过期/被吊销/IP 不在白名单（`key_expired`/`API_KEY_REVOKED`/`ip_not_allowed`） |
| `/v1` 403 | 密钥缺少对应作用域，到密钥页确认 |
| 429 频繁 | 调高密钥 `rateLimitPerMin`、合并请求；或项目月配额耗尽（`quota_exceeded`） |
| 423 登录被锁 | 连续失败触发；等待 15 分钟或重置密码/清 `locked_until` |
| 图谱为空 | 项目设置 `graphEnabled` 关闭，或记忆尚未产生实体 |
| 检索无结果 | 阈值过高（`threshold`）或作用域不匹配；在演练场调试 |
| `database is locked` | 确认只有一个进程写库；不要用其他 GUI 工具长事务锁库；检查是否有 VACUUM 在跑 |
| 中文检索差 | 确认记忆已索引（`memory_terms` 非空）；调高关键词权重 |
| `/metrics` 404 | `MNEMOS_METRICS_ENABLED=0`，或请求命中了 SPA 静态回退（确认路径） |
| 备份 API 404 | 版本尚未包含 `/api/ops/*`；升级到包含运维路由的版本，或用 `VACUUM INTO` 兜底 |
| 恢复后 `/readyz` 503 | schema_version 落后（未跑迁移）或恢复的文件不完整；重新启动触发迁移并核对备份完整性 |
| 端口被占用 | `bash scripts/preflight.sh` 会 FAIL；`lsof -i :4380` 找到占用进程 |
| 容器健康检查失败 | 确认容器内 `MNEMOS_PORT` 与探针端口一致；查看 `docker inspect` 健康日志（本机未验证 Docker） |

## 14. 附：常用命令

```bash
# 预检 / 冒烟 / 压测 / 安全检查 / 备份演练
bash scripts/preflight.sh
node scripts/smoke-api.mjs
node scripts/load-test.mjs --concurrency 32 --duration 30
node scripts/security-check.mjs --auto-start --base http://127.0.0.1:4392
bash scripts/backup-restore-drill.sh

# 健康与指标
curl -fsS http://127.0.0.1:4380/healthz
curl -fsS http://127.0.0.1:4380/readyz | jq .
curl -fsS http://127.0.0.1:4380/metrics | grep '^mnemos_http_requests_total' | head

# 数据库
sqlite3 -readonly data/mnemos.db "PRAGMA integrity_check;"
sqlite3 -readonly data/mnemos.db "SELECT value FROM meta WHERE key='schema_version';"
sqlite3 -readonly data/mnemos.db "SELECT COUNT(*) FROM memories;"

# 优雅停机
kill -TERM "$(pgrep -f 'server/src/main.ts')"
```
