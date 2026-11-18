# 运维手册（v6.4）

> 配套：[安全模型](security.md) · [可观测性](observability.md) · [百万级与压测](v6-scale.md) ·
> [API](api.md) · [大模型设置](llm-settings.md)
> 示例假设服务在 `http://127.0.0.1:4380`，演示账号 `admin@mnemos.dev / Demo123456`（仅演示环境）。

---

## 1. 运行要求

- **Node.js ≥ 22.18**（`node:sqlite` 与原生 TypeScript；推荐 24/26），pnpm 10.4。
- 无外部数据库：SQLite 内置，单进程、单写者；无需 Redis/MQ/对象存储。
- 单机 1 vCPU / 512MB 可跑演示数据；1M 人分区建议 ≥2GB RAM（见 [v6-scale](v6-scale.md)）。
- 可用 `sqlite3` 命令行排障（可选）。

## 2. 启动

```bash
# 首次：安装依赖、写入演示数据（数据目录 data-v6/）
pnpm install
pnpm seed              # 生成演示组织/分区/人/记忆/密钥，并打印演示 API Key
pnpm build             # 构建控制台 web/dist（不构建也能用 API）

# 启动（默认 127.0.0.1:4380，数据目录 data-v6/）
pnpm start             # 或 pnpm dev（node --watch）

# 前端热更新（另开一个进程；代理 /api /v1 到 4380）
pnpm dev:web
```

- `pnpm seed` 使用 `--force` 清空 v6 全部演示数据（含 org/users），**可重复执行**：

  ```bash
  pnpm seed
  ```

- 服务端**不会自动读取 `.env`**（只读进程环境变量）。需要 .env 时用：

  ```bash
  node --env-file=.env server/src/main.ts
  ```

### 生产启动（systemd 示例）

```ini
# /etc/systemd/system/mnemos.service
[Unit]
Description=Mnemos v6 Memory Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mnemos
Environment=NODE_ENV=production
Environment=MNEMOS_HOST=127.0.0.1
Environment=MNEMOS_PORT=4380
Environment=MNEMOS_DATA_DIR=/var/lib/mnemos
Environment=MNEMOS_BACKUP_DIR=/var/lib/mnemos/backups
Environment=MNEMOS_DEMO=0
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

反向代理（TLS 终止；探针只允许内网）：

```nginx
server {
  listen 443 ssl http2;
  server_name memory.example.com;

  location / {
    proxy_pass http://127.0.0.1:4380;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
  }

  location ~ ^/(metrics|healthz|readyz|health)$ {
    allow 10.0.0.0/8;
    allow 127.0.0.1;
    deny all;
    proxy_pass http://127.0.0.1:4380;
  }
}
```

反代后设置 `MNEMOS_TRUST_PROXY=1`（取 XFF 真实 IP）；TLS 终止后设 `MNEMOS_HSTS=1`。
容器方式见 `Dockerfile` / `docker-compose.yml`（本机无 Docker，未真机验证）。

### 首次启动（生产模式）

`MNEMOS_DEMO=0` 且库里没有用户时，必须提供初始 owner，否则进程拒绝启动：

```bash
MNEMOS_DEMO=0 \
MNEMOS_BOOTSTRAP_EMAIL=admin@example.com \
MNEMOS_BOOTSTRAP_PASSWORD='ChangeMe-12345' \
MNEMOS_BOOTSTRAP_NAME='平台管理员' \
MNEMOS_BOOTSTRAP_ORG_NAME='我的组织' \
MNEMOS_BOOTSTRAP_ORG_SLUG=my-org \
pnpm start
```

创建后立即在控制台修改密码，并从环境变量中移除明文密码。

## 3. 配置项（v6.4）

完整列表与注释见 [`.env.example`](../.env.example)。生产要点：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MNEMOS_HOST` | `127.0.0.1` | 生产只监听回环，由反代暴露 |
| `MNEMOS_PORT` | `4380` | 监听端口（兼容 `PORT`） |
| `MNEMOS_DATA_DIR` | `<项目根>/data-v6` | 数据目录（权限 700） |
| `MNEMOS_DB_PATH` | `$DATA_DIR/mnemos.db` | SQLite 路径 |
| `MNEMOS_BACKUP_DIR` | `$DATA_DIR/backups` | 备份目录（需可写） |
| `MNEMOS_DEMO` | `1` | **生产设 0**，禁止空库写入演示数据 |
| `MNEMOS_AUTH_DISABLED` | `0` | 仅本机调试；生产启动直接拒绝 |
| `MNEMOS_DEV_NO_API_KEY` | `0` | v6.5 本地免密：`/v1` 无需 API Key（以第一个 owner 合成 org key）；仅本地开发，生产启动直接拒绝 |
| `MNEMOS_SESSION_TTL_HOURS` | `72` | 控制台会话有效期 |
| `MNEMOS_LOGIN_MAX_ATTEMPTS/LOCK_MINUTES` | `5` / `15` | 登录锁定 |
| `MNEMOS_LOG_LEVEL/FORMAT` | `info` / 生产 `json` | 日志 |
| `MNEMOS_METRICS_ENABLED` | `1` | 关闭时 `/metrics` 404 |
| `MNEMOS_TRUST_PROXY` | `0` | 反代后设 1 |
| `MNEMOS_HSTS` | `0` | 全站 HTTPS 后设 1 |
| `MNEMOS_QUOTA_ENFORCE` | `1` | 分区月配额强制 |
| `MNEMOS_REQUEST_TIMEOUT_MS` | `30000` | 请求超时 |
| `MNEMOS_SHUTDOWN_TIMEOUT_MS` | `10000` | 优雅停机等待上限 |
| `MNEMOS_MAINTENANCE_INTERVAL_MIN` | `360` | 维护任务间隔 |
| `MNEMOS_BODY_LIMIT_BYTES` | `1048576` | 请求体上限 |
| `MNEMOS_DREAM_SCHEDULER/TICK_MS` | `1` / `60000` | 分区级做梦调度 |
| `MNEMOS_WECOM_MOCK` | 跟随 `MNEMOS_DEMO` | 登录页企业微信 Mock；生产必须 0 |
| `MNEMOS_ENCRYPTION_KEY` | 空 | v6.4：AES-256-GCM 加密模型 API Key，同时保护附件 URL 与占位符值；空=明文（仅开发） |
| `MNEMOS_LLM_BASE_URL` | 空 | LLM 阶段未配置时的回退 baseUrl（OpenAI 兼容，兼容 `OPENAI_BASE_URL`） |
| `MNEMOS_LLM_API_KEY` | 空 | 回退密钥（兼容 `OPENAI_API_KEY`）；与 baseUrl 同时存在才启用回退 |
| `MNEMOS_LLM_MODEL` | `gpt-4o-mini` | 回退模型；不配则离线确定性实现（画像摘要同样回退确定性） |
| `MNEMOS_STORAGE` | `sqlite` | postgres 未实现，启动会拒绝 |

启动时 `assertEnv` 校验：数据/备份目录可写、端口/超时/维护间隔/日志级别合法、
生产禁止 `AUTH_DISABLED` 与 `DEV_NO_API_KEY`；失败直接退出。

> **本地免密（v6.5，仅开发）**：`MNEMOS_DEV_NO_API_KEY=1` 时 `/v1` 跳过 API Key 校验，
> 以库中第一个 `owner` 身份合成一把 org 级 Key（`admin` 作用域、不落库）；DSH 插件
> `orgApiKey` 可留空。仅限本机开发，`NODE_ENV=production` 时启动校验会直接拒绝。
> 公开探针（`/health` 等）不受影响，控制台 `/api` 鉴权也不受影响。

## 4. 数据与备份

### 4.1 文件布局

- 数据库：`$MNEMOS_DATA_DIR/mnemos.db`（伴随 `-wal`、`-shm`）。
- 备份：`$MNEMOS_BACKUP_DIR/mnemos-YYYYMMDD-HHmmss-<kind>.db`（UTC；kind：`manual` /
  `scheduled` / `preflight`），滚动保留最近 **14** 份。
- v5 的 `data/` 不再使用；v6 不读取、不迁移 v5 库（启动时检测到 v5 schema 会拒绝）。

### 4.2 在线备份

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4380/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"…"}' | jq -r .token)

curl -s -X POST http://127.0.0.1:4380/api/ops/backup \
  -H "authorization: Bearer $TOKEN" | jq .
# → {"id":"bkp_…","file":"mnemos-20261117-160000-manual.db","sizeBytes":…,"kind":"manual",…}

curl -s http://127.0.0.1:4380/api/ops/backups -H "authorization: Bearer $TOKEN" | jq .
curl -fsS -OJ http://127.0.0.1:4380/api/ops/backups/mnemos-20261117-160000-manual.db \
  -H "authorization: Bearer $TOKEN"
```

备份使用 SQLite `VACUUM INTO`，生成一致性快照，不锁库。无 API 时手工兜底：

```bash
sqlite3 data-v6/mnemos.db "VACUUM INTO '/backup/mnemos-$(date +%F-%H%M).db';"
```

### 4.3 恢复

```bash
# 1) 停服务（SIGTERM，优雅停机）
kill -TERM "$(pgrep -f 'server/src/main.ts')"

# 2) 保留现场
cp data-v6/mnemos.db /var/tmp/mnemos-before-restore.db

# 3) 替换并清理 WAL
cp /backup/mnemos-20261117-160000-manual.db data-v6/mnemos.db
rm -f data-v6/mnemos.db-wal data-v6/mnemos.db-shm

# 4) 启动并验证
node server/src/main.ts
curl -fsS http://127.0.0.1:4380/readyz | jq -e '.ok == true'
curl -fsS http://127.0.0.1:4380/health | jq '{ok,schemaVersion}'
```

恢复后如计数异常：控制台 `POST /api/partitions/:partition/reconcile`。

### 4.4 备份策略

- 每日至少一次 `POST /api/ops/backup`（外部 cron / 调度器；应用无内置定时备份）。
- 备份目录 0700；上传异地前用 age/GPG/KMS 加密（应用不加密备份）。
- 每月一次恢复演练：在临时目录 + 临时端口恢复并查询，不要覆盖生产库。
- v6 备份恢复演练：用 `POST /api/ops/backup` + 独立数据目录恢复后跑 `node scripts/preflight.ts` 与 `pnpm test`。
  演练请按 4.2–4.3 手工执行。

## 5. 健康检查与探针

| 端点 | 鉴权 | 用途 | 期望 |
| --- | --- | --- | --- |
| `GET /healthz` | 无 | liveness | 200 `{ok:true}` |
| `GET /readyz` | 无 | readiness（DB 可查询） | 200 `{ok:true}`；否则 503 |
| `GET /health` / `/api/health` | 无 | 版本/uptime/schema/db/node | 200；DB 异常 503 |
| `GET /metrics` | 无（内网） | Prometheus 文本 | 200 text/plain |

```bash
curl -fsS http://127.0.0.1:4380/healthz
curl -fsS http://127.0.0.1:4380/readyz | jq .
curl -fsS http://127.0.0.1:4380/health | jq '{ok,version,schemaVersion,db}'
curl -fsS http://127.0.0.1:4380/metrics | grep '^mnemos_http_requests_total' | head
```

K8s 参数建议：liveness `/healthz`（10s 周期，3 次失败）；readiness `/readyz`（5s 周期）。

## 6. 日志与指标

生产默认 JSON（每行一条），关键字段：`ts`、`level`、`msg`、`method`、`path`、`status`、
`latencyMs`、`requestId`、`route`、`ip`、`actor`、`error`。慢请求（>1s）记 `warn`，5xx 记 `error`；
敏感字段（authorization/password/token/secret 等）递归脱敏。

指标（`/metrics`）：

| 指标 | 类型 | 标签 | 用途 |
| --- | --- | --- | --- |
| `mnemos_http_requests_total` | counter | method, route, status | QPS / 错误率 |
| `mnemos_http_request_duration_milliseconds` | histogram | method, route | p50/p95/p99（毫秒） |
| `mnemos_http_errors_total` | counter | route, status | 5xx 汇总 |
| `mnemos_rate_limited_total` | counter | route | 限流 |
| `mnemos_auth_failures_total` | counter | — | 登录/鉴权失败 |
| `mnemos_auth_logins_total` | counter | result | 登录结果 |
| `mnemos_timeouts_total` | counter | — | 请求超时 |
| `mnemos_maintenance_runs_total` | counter | status, dryRun | 维护任务 |
| `mnemos_maintenance_last_duration_ms` | gauge | — | 维护耗时 |
| `mnemos_uptime_seconds` / `mnemos_build_info` | gauge | version | uptime / 版本 |

完整面板与告警见 [observability.md](observability.md)。

## 7. v6.1 异步任务、回填与评测

### 7.1 异步写管线（memory_jobs）

服务启动即拉起同进程 worker（`startMemoryJobWorker`），默认每 **1s** 处理一批（10 条）：

- 任务来自写入事务：`embed`（补 embedding）、`extract`（实体/关系）、`profile`（facts/画像）。
- 失败重试 5 次（指数退避）；重启后 `running` 超过 5 分钟自动重新入队，任务不丢。
- 手动排障（admin）：`POST /api/ops/jobs/tick {"limit":20}` → `{claimed,done,failed,at}`；
  可连续调用直到 `claimed=0`。
- 观察积压：
  ```bash
  sqlite3 data-v6/mnemos.db "SELECT status, type, COUNT(*) FROM memory_jobs GROUP BY status, type;"
  ```
  大量 `pending` 且 worker 未动 → 检查进程是否存活、是否有长事务锁库；大量 `failed` 看 `error`。

### 7.2 回填历史 embedding

v6 → v7 迁移不阻塞启动；升级后旧记忆的 `embedding` 为空（检索会退化为 keyword 信号）：

```bash
# 全量补齐（默认读取 data-v6/mnemos.db）
pnpm backfill:embeddings

# 指定库 / 预演
node scripts/backfill-embeddings.ts --db /var/lib/mnemos/mnemos.db
node scripts/backfill-embeddings.ts --db /var/lib/mnemos/mnemos.db --dry-run
```

- 幂等：只处理 `embedding IS NULL`（或模型变更）的记忆；可重复执行。
- 大数据量建议低峰运行；批事务写入，单进程单写者，避免与备份/VACUUM 并发。

### 7.3 计数校准（reconcile）

手工 SQL / 批量导入绕过触发器后，计数可能漂移：

```bash
curl -s -X POST http://127.0.0.1:4380/api/partitions/<partition>/reconcile   -H "authorization: Bearer $TOKEN" | jq .
```

重算该分区 `partition_stats` 与所有 `persons` 计数（全表聚合，低频操作）。人合并后同样建议执行。

### 7.4 记忆质量评测（eval）

```bash
pnpm eval                      # 7 个场景，全通过 exit 0
pnpm --silent eval > eval-report.json
jq '.summary' eval-report.json
```

覆盖改写召回、时效更新、冲突取代、隔离、反馈调权、人合并、画像 facts；阈值与扩展见
[`eval.md`](eval.md)。建议在 CI 中作为 `pnpm verify` 之外的门禁。

## 8. 维护任务

启动后 60s 首次执行，之后每 `MNEMOS_MAINTENANCE_INTERVAL_MIN`（默认 360 分钟）；
也可 `POST /api/ops/maintenance` 手动触发（admin+）。

| 任务 | 行为 |
| --- | --- |
| 过期记忆归档 | `expires_at` 已过的 `active` 记忆 → `archived` |
| 保留期归档 | 分区 `settings.retentionDays > 0` 时，早于该天数的 `active` 记忆 → `archived` |
| 软删除清理 | `status=deleted` 超过 30 天的记忆物理删除 |
| 会话清理 | 过期 `user_sessions` 删除 |
| WAL checkpoint | `PRAGMA wal_checkpoint(TRUNCATE)` |
| VACUUM（可选） | 仅手动 `{"vacuum":true}`；会阻塞写，需 ≥2× 库大小空闲磁盘 |

```bash
# 预演（只统计不写）
curl -s -X POST http://127.0.0.1:4380/api/ops/maintenance \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"dryRun":true}' | jq .

# 历史
curl -s "http://127.0.0.1:4380/api/ops/maintenance?limit=20" -H "authorization: Bearer $TOKEN" | jq .
```

失败会在 `maintenance_runs` 记录 `failed`，不中断调度器；大库首次归档建议低峰执行。

## 9. 大模型设置与密钥轮换（v6.4）

设计、字段、协议与成本公式见 [llm-settings.md](llm-settings.md)；本节只讲运维动作。

### 9.1 优先级：控制台设置 > 环境变量 > 确定性

| 顺序 | 来源 | 生效条件 | 说明 |
| --- | --- | --- | --- |
| 1 | `llm_stage_configs` + `llm_providers` | 阶段行存在、`enabled=true`、供应商存在且启用、模型/密钥可用 | 推荐方式；改完立即生效，无需重启 |
| 2 | 环境变量 | 阶段未配置（或配置未完成）且 `MNEMOS_LLM_BASE_URL` + `MNEMOS_LLM_API_KEY` 非空 | 兼容 v6.3；协议固定 `openai`，模型 `MNEMOS_LLM_MODEL` |
| 3 | 确定性逻辑 | 以上都不可用，或调用失败/超时 | 简报压缩、做梦规则归并、画像拼接、regex 隐私规则；主流程不受影响 |

- **阶段 `enabled=false`**：显式关闭该阶段，不调 LLM、**不回退环境变量**、不写 `llm_calls`。
- **供应商 `enabled=false`**：同上（显式禁用）。
- 阶段启用但供应商被删/无密钥/无模型：视为「配置未完成」，回退环境变量；都没有则确定性。
- 环境变量回退只支持 OpenAI 兼容协议；Anthropic 必须配供应商。
- 环境变量在**启动时**读取（`loadEnv`），修改后需重启；控制台配置即时生效。
- `GET /api/llm/status` 的 `envFallbackConfigured` 可确认当前 env 回退是否就绪。

### 9.2 首次配置（控制台或 curl）

1. 组织设置 → **模型设置** → 新建供应商（baseUrl、默认模型、API Key、价格、启用）。
2. 点「测试连接」，确认 `ok=true` 与延迟；失败先看第 9.5 节。
3. 阶段配置表逐行选择供应商/模型；建议先只配 `brief`，观察 `usage` 与日志再扩到其他阶段。
4. `GET /api/llm/status`：`providers/stages` 计数符合预期，`encryptionConfigured=true`（生产）。
5. 触发一次人级简报（`GET /api/partitions/:p/persons/:person/brief?force=true`），确认
   `llm_calls` 出现 `status='ok'`。

```bash
# 测试连接（不回显密钥；15s 超时；不写 llm_calls）
curl -s -X POST "$BASE/api/llm/providers/<id>/test" -H "authorization: Bearer $TOKEN" | jq .

# 近 30 天用量
curl -s "$BASE/api/llm/usage?days=30" -H "authorization: Bearer $TOKEN" | jq .

# 直接查库排障（不记录 prompt，可安全查看）
sqlite3 data-v6/mnemos.db \
  "SELECT stage,status,model,count(*) FROM llm_calls WHERE created_at > datetime('now','-1 day') GROUP BY 1,2,3;"
```

### 9.3 密钥轮换

`MNEMOS_ENCRYPTION_KEY` 是**共享加密密钥**：模型 API Key、附件 URL、隐私占位符值都用它
（AES-256-GCM，密文格式 `v1:iv:tag:cipher`）。当前实现**没有 key id / 多密钥解密**，
所以轮换是一个需要维护窗口的操作：

1. 备份旧密钥（密码管理器/KMS），并确认 `data-v6/` 与备份目录的访问控制；
2. 停服，设置新的 `MNEMOS_ENCRYPTION_KEY`，重启；
3. 旧密文无法解密：
   - 模型供应商 `hasApiKey` 仍为 true，但 `apiKeyMasked` 为空、测试连接报无法解密 →
     在控制台对每个供应商重新 PATCH 一次 API Key；
   - 附件 URL、占位符值需要按业务重新写入或从明文源恢复（没有自动 re-encrypt 脚本）；
4. 逐个「测试连接」，并抽查附件/占位符读取；
5. 确认无误后再销毁旧密钥；回滚方案 = 换回旧密钥并重启（期间不要覆盖旧密文）。

> 建议：把 `MNEMOS_ENCRYPTION_KEY` 当作**长期密钥**，只在泄露/合规要求时轮换；
> 轮换前先评估存量附件与占位符，必要时先导出明文再切换。只换模型 API Key（不动加密密钥）时，
> 直接在控制台 PATCH 单个供应商即可，不影响其他数据。

### 9.4 成本控制

| 阶段 | 建议模型档位 | 理由 |
| --- | --- | --- |
| `privacy` | 小/快模型（gpt-4o-mini、qwen-plus、本地 Ollama） | 高频、短输出、JSON 抽取；失败自动回退 regex |
| `brief` | 小/快模型 | 高频、有确定性兜底；`maxTokens` 1024 足够 |
| `dream` | 大模型（claude-sonnet、gpt-4.1） | 低频、要求归并与抽象质量 |
| `profile` | 大模型 | 低频、面向用户的画像摘要 |
| `extract` | 不配（预留） | v6.4 无调用点 |

- 价格填 `$/1M tokens`（不是 `$/1K`）；本地模型可填 0，成本仍按 token 统计。
- 用 `maxTokens` 控 completion 成本：privacy 512、brief 1024、dream/profile 1200–1600。
- 定期看 `usage`：`calls` 异常升高通常意味着上游重试/循环；持续 401 不会产生 tokens，但会刷日志。
- 高敏场景可让 `privacy`/`brief` 走本地 vLLM/Ollama，只有 dream/profile 出网。

### 9.5 故障排查

| 现象 | 排查 |
| --- | --- |
| 「测试连接」401/403 | API Key 错、被吊销、缺模型权限；确认密钥填的是供应商 key，不是 Mnemos 的 `mnemos_live_…` |
| 「测试连接」超时 | 出网被拦/代理未配/DNS；先在同一台机器 `curl` 供应商端点；本地 Ollama 确认 11434 监听 |
| 404（Anthropic） | baseUrl 填错域名/代理路径；建议填 `https://api.anthropic.com`，服务端会补 `/v1/messages` |
| 404（OpenAI 兼容） | baseUrl 少写 `/v1` 或多了路径；以 `/chat/completions` 结尾会被原样使用 |
| 响应非 JSON / 结构异常 | 协议选错、baseUrl 指向网页/网关、模型名不对；先 curl 看原始响应与状态码 |
| 配了阶段但仍走 env | 阶段行未保存（看 `/api/llm/status.stages` 计数）、`enabled=false`、供应商被禁用；`GET /stages` 的默认值不代表已保存 |
| 配了 env 但没效果 | 只配了 key 或只配了 baseUrl；两者都要；修改后是否重启 |
| `usage` 空 | 时间窗内无调用；调用全被 provider 禁用/阶段关闭（不发请求，不写 `llm_calls`）；`days` 范围 1–90 |
| 成本明显偏高 | 检查是否把大模型配到 brief/privacy；`maxTokens` 是否过大；供应商价格是否误填 `$/1K` |
| 供应商 `apiKeyMasked` 为空/测试报无法解密 | 加密密钥变更/丢失；重新 PATCH API Key（`hasApiKey` 仍为 true） |
| 简报/画像突然变短 | LLM 失败回退确定性；查 `llm_calls.status/error` 与日志中的 LLM 告警 |

## 10. 密钥轮换与登录锁定

```bash
# 创建最小作用域分区 key（secret 只返回一次）
curl -s -X POST http://127.0.0.1:4380/api/partitions/<partition>/keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"api-v2","scopes":["memories:read","memories:write"],"rateLimitPerMin":600}' | jq .

# 轮换：graceHours 仅写审计，v6 立即吊销旧 key
curl -s -X POST http://127.0.0.1:4380/api/partitions/<partition>/keys/<keyId>/rotate \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"graceHours":0}' | jq .

# 吊销
curl -s -X DELETE http://127.0.0.1:4380/api/partitions/<partition>/keys/<keyId> \
  -H "authorization: Bearer $TOKEN"
```

- 登录连续失败 5 次后锁定 15 分钟（第 5 次仍 401，之后 423 `account_locked`）；解锁：

  ```bash
  sqlite3 data-v6/mnemos.db "UPDATE users SET locked_until=NULL, failed_login_attempts=0 WHERE email='admin@example.com';"
  ```

- 管理员重置账号密码：`POST /api/org/users/:id/reset-password`（返回一次性临时密码并清理会话）。

## 11. 升级与回滚

1. **备份**：`POST /api/ops/backup`。
2. **预检**：`MNEMOS_DATA_DIR=data-v6 node scripts/preflight.ts`；确认目录可写、端口空闲、DB 完整性与 schema 版本。
3. **部署**：拉代码 → `pnpm install --frozen-lockfile` → `pnpm build`（前端）→ 重启进程。
4. **schema**：启动时幂等执行 `schema.sql`（`IF NOT EXISTS`，补索引/触发器）；
   v6 库自动升级到 v7（补列 + 回填 hash/valid_from），v8→v9 补隐私规则库，v9→v10 纯新增
   `llm_providers` / `llm_stage_configs` / `llm_calls`（不改既有表）；当前 `meta.schema_version` 为 10；
   检测到 v5 库会拒绝启动。升级后跑 `pnpm backfill:embeddings` 补历史向量。
5. **验证**：`/readyz`、`/health`、控制台登录、关键列表/搜索。
6. **回滚**：停新版本 → 回退代码/镜像 → 启动旧版本。若期间 schema 已变更，
   先恢复升级前备份（替换 `mnemos.db` 并删除 `-wal/-shm`）。

```bash
sqlite3 -readonly data-v6/mnemos.db "SELECT value FROM meta WHERE key='schema_version';"
sqlite3 -readonly data-v6/mnemos.db "PRAGMA integrity_check;"
```

## 12. 容量与性能

- 1M 人分区列表/搜索预算与实测、种子与压测步骤见 [v6-scale.md](v6-scale.md)。
- 单进程单写者：写入串行；大量导入用批事务；避免与 VACUUM/备份争 I/O。
- 列表性能依赖 `partition_stats` 与索引：不要在生产 SQL 里加 `COUNT(*)` 或逐行 stats。
- 用量事件会持续增长，可按需清理（保留审计）：`DELETE FROM usage_events WHERE created_at < ?`。
- 审计日志按合规要求保留，建议外送 SIEM。

## 13. 常见问题

| 现象 | 排查 |
| --- | --- |
| 启动报“检测到 v5 数据库” | v6 不迁移旧库；确认 `MNEMOS_DATA_DIR`/`MNEMOS_DB_PATH` 指向 `data-v6/` |
| 启动报“数据库中没有用户” | 生产首次启动需 `MNEMOS_BOOTSTRAP_*`；或演示环境设 `MNEMOS_DEMO=1` |
| 控制台白屏 | 是否执行过 `pnpm build` 生成 `web/dist`；`curl -I /assets/…` |
| `/api` 401 | 会话过期（72h）或账号被禁用；重新登录 |
| `/v1` 401 | Key 不存在/被吊销/过期/格式不对（`INVALID_API_KEY` / `API_KEY_REVOKED` / `KEY_EXPIRED`） |
| `/v1` 403 | 作用域不足、分区归档、分区 key 建分区或 IP 不在白名单 |
| 429 | Key 每分钟限流（看 `X-RateLimit-*`），或分区月配额耗尽（`QUOTA_EXCEEDED`）；调 `rateLimitPerMin` / 配额或退避重试 |
| 423 | 登录失败锁定；等待窗口或重置密码/清 `locked_until` |
| 400 `INVALID_CURSOR` | 换了 `sort` 还传旧游标；重新从第一页取 |
| 人列表计数为 0/不准 | 绕过触发器写入；执行 `POST /api/partitions/:p/reconcile` |
| 搜索无结果 | `q` 是前缀匹配；中文走子串；检查 scope/person 过滤 |
| `database is locked` | 确认只有一个写进程；不要用 GUI 工具长事务锁库；避开 VACUUM/备份 |
| `/metrics` 404 | `MNEMOS_METRICS_ENABLED=0`，或请求命中了 SPA 静态回退 |
| 备份 API 404 | 版本不含运维路由；用 `VACUUM INTO` 兜底 |
| 检索没有 vector 信号 | 旧记忆未回填 embedding；跑 `pnpm backfill:embeddings` 或等 worker |
| 图谱为空 | `settings.autoExtractEntities=false` 或 extract 任务未跑；看 `memory_jobs` |
| 附件 URL 读不出 | 配置了 `MNEMOS_ENCRYPTION_KEY` 但换/丢了密钥；密文无法用新密钥解密 |
| 模型设置 401/超时/404 | 见 [9.5 故障排查](#95-故障排查)；先用 curl 直连供应商排除网络/密钥问题 |
| 阶段配置不生效 | 阶段行未保存/`enabled=false`/供应商禁用；看 `GET /api/llm/status.stages` 与 `llm_calls` |
| 模型用量为 0 | 无实际调用（阶段关闭/供应商禁用不发请求），或 `days` 超出 1–90 |
| 502/503 写重试重复 | 写接口未带 `Idempotency-Key`；v6.1 建议所有写请求带稳定幂等键 |
| 恢复后 `/readyz` 503 | 备份不完整或 schema 不匹配；重新启动触发迁移并核对 `integrity_check` |

## 14. 脚本现状（v6.4）

| 脚本 | 用途 |
| --- | --- |
| `scripts/preflight.ts` | 上线预检：数据目录/完整性/schema/端口/账号 |
| `scripts/seed-scale.ts` | 规模种子（默认 10 万，可 100 万） |
| `scripts/perf-persons.ts` | 人列表/搜索/统计/详情/记忆压测 |
| `scripts/backfill-embeddings.ts` | 补历史记忆 embedding（`pnpm backfill:embeddings`） |
| `scripts/eval-memory.ts` | v6.1 记忆质量评测（`pnpm eval`） |
| `pnpm seed`（`server/src/seed/run-seed.ts`） | v6 演示数据（幂等） |
