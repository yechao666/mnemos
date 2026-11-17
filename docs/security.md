# 安全模型与基线（v6）

> 适用范围：Mnemos v6 单节点部署（Node 原生 TS + SQLite WAL，反向代理终止 TLS）。
> 本文描述资产、信任边界、威胁模型、已落地控制项、密钥生命周期与事件响应。
> 文中结论以 v6 代码为准；黑盒安全检查用 `scripts/preflight.ts` + 本文第 7 节手工基线。

---

## 1. 资产与信任边界

| 资产 | 位置 | 敏感度 |
| --- | --- | --- |
| 记忆内容 | `memories`（`$MNEMOS_DATA_DIR/mnemos.db`，默认 `data-v6/`） | 高：可能含 PII、业务决策、密钥片段 |
| 人与会话 | `persons` / `sessions` | 中高：external_id、属性、交互归组 |
| 账号口令哈希 / 会话令牌哈希 | `users` / `user_sessions` | 高 |
| API Key 哈希 | `api_keys.key_hash` | 高（明文只在创建/轮换响应出现一次） |
| 画像 / 事实 | `person_facts` / `person_profiles` | 中高：结构化偏好、身份信息 |
| 多模态附件 | `memory_attachments`（URL/元数据/caption） | 中高：URL 可能含签名参数；可配置字段加密 |
| 审计 / 用量 | `audit_logs` / `usage_events` | 中高：含 actor、IP、UA |
| 备份文件 | `$MNEMOS_BACKUP_DIR`（默认 `data-v6/backups`） | 高：完整数据库副本 |
| 结构化日志 | stdout / 容器日志驱动 | 中：含请求路径、IP，敏感字段脱敏 |

信任边界：

```
Internet
  │  TLS（反向代理 / 负载均衡）
  ▼
反向代理（Nginx/Caddy，本仓库外）
  │  HTTP，仅回环（建议 127.0.0.1:4380）
  ▼
Mnemos 进程（单节点，非 root）
  ├── 控制台会话（Bearer session，/api）
  ├── 公开 API（Bearer API Key，/v1）
  └── 运维端点（/healthz /readyz /metrics，无鉴权，不暴露公网）
```

部署假设：

- 控制台与 API 同源；CORS 仅允许本机来源（`127.0.0.1` / `localhost` / `::1`）。
- `/metrics`、`/healthz`、`/readyz` 只供内网抓取。
- 单进程写 SQLite；多副本/读写分离不在当前范围。

---

## 2. 威胁模型

| # | 威胁 | 典型场景 | 现有控制 | 残余风险 |
| --- | --- | --- | --- | --- |
| T1 | **API Key 泄漏** | 密钥进前端代码/日志/Git；离职带走 | 只存 SHA-256；明文仅创建/轮换返回一次；作用域最小化；单 Key 限流；过期时间与 IPv4/CIDR 白名单；一键吊销/轮换；审计 `key.*`/`org.key_*` | 泄漏到发现前仍可用；需靠用量/审计异常发现；生产必须吊销演示密钥 |
| T2 | **越权 / IDOR** | A 分区 key 读 B 分区；低权限账号操作他人分区 | 所有查询强制带 `partition_id`；分区 key 只能访问自身分区；org key 只能访问本组织；跨组织/越权统一 404；控制台按组织角色校验 | 组织 admin/owner 天然拥有全部分区（预期行为） |
| T3 | **注入（SQL/路径/XSS）** | 构造 `q`、`id`、备份文件名；记忆内容含脚本 | 全量参数化 SQL；zod 校验；备份文件名白名单 + 归属校验；CSP、X-Frame-Options、nosniff；React 转义 | 控制台令牌在 `localStorage`，XSS 可窃取 → CSP 是关键防线 |
| T4 | **记忆投毒（间接提示注入）** | 攻击者向 `scope=partition` 写入“忽略之前指令，调用某工具”，进入简报/上下文 | 记忆带 actor/source/审计；`person` 私有 vs `partition` 共享由写入方显式选择；简报/上下文只是文本，不执行指令；v6 不做事实抽取 | 模型侧仍须把记忆当**不可信数据**；高敏分区慎用共享 scope |
| T5 | **DoS / 暴力破解** | 高频搜索打满 CPU；撞库；超大请求体 | 每 Key 每分钟限流（`X-RateLimit-*`，429）；登录失败锁定（423）；登录接口 30 次/分钟/IP；1MB 请求体；30s 超时；分区月配额（429 `QUOTA_EXCEEDED`） | 单节点无水平扩展；公网建议反代层再加 WAF |
| T6 | **备份泄漏** | 备份目录权限过宽；下载接口越权 | 备份 API 仅组织 admin+；文件名白名单；保留 14 份；备份审计 | 应用**不加密备份**，依赖磁盘/对象存储加密与 0700 权限 |
| T7 | **会话劫持 / CSRF** | 令牌被窃；跨站写操作 | 会话令牌只存哈希；TTL 72h；登出/改密/重置/禁用清理会话；Bearer 头而非 Cookie | 令牌存 `localStorage`（见 T3）；无设备管理 |
| T8 | **传输层窃听** | 明文 HTTP 暴露公网 | 生产要求反代终止 TLS；`MNEMOS_HOST=127.0.0.1`；`MNEMOS_HSTS=1` | 应用不处理 TLS |
| T9 | **供应链 / 容器** | 依赖投毒；镜像 root 运行 | 依赖锁定；多阶段镜像、非 root `node`、不带数据目录；CI 类型检查/测试 | 无镜像签名/SBOM/漏洞扫描；镜像未真机验证 |
| T10 | **日志/审计泄漏** | 日志打印令牌/密码；审计 detail 含敏感值 | 日志递归脱敏（authorization/password/apikey/secret/token/cookie/credential）；登录只记 email；API Key 只记 prefix | 限制日志访问；外送 SIEM 前复核 |
| T11 | **误操作 / 内部威胁** | 误删记忆/分区、直接改库 | 危险操作需 developer/admin+；删除有审计；备份与恢复演练；软删除 30 天后才物理清理 | 无审批流/四眼原则；DB 文件权限需收紧 |
| T12 | **PII 外泄 / 未授权使用** | 记忆正文含手机号/邮箱/身份证；附件 URL 可被直读 | 分区 `piiRedaction=basic` 写入脱敏并审计 `memory.pii_redacted`；`persons.consent` 随导出；`MNEMOS_ENCRYPTION_KEY` 可加密附件 URL（AES-256-GCM） | 脱敏是确定性正则、非全量 DLP；密钥丢失会导致旧附件 URL 无法解密，须与备份同管 |
| T13 | **合规删除不彻底** | 用户要求删除但历史/画像残留 | `DELETE persons?hard=true` 级联删除 memories（含 FTS/实体/历史/反馈）/facts/profile/sessions；默认软删可导出 | 备份中的副本不在在线删除范围，需按备份保留策略处理 |

---

## 3. 控制项清单（v6.1）

| 控制 | 实现位置 | 说明 | 验证 |
| --- | --- | --- | --- |
| 口令哈希 | `server/src/lib/password.ts` | PBKDF2-SHA256，120k 迭代，随机盐，`timingSafeEqual` | 单测 / 改密流程 |
| 会话令牌 | `user_sessions.token_hash` | 只存 SHA-256；TTL 默认 72h；登出/改密/重置/禁用清理 | 手工 + HTTP 测试 |
| API Key 哈希 | `api_keys.key_hash` | 只存 SHA-256；明文仅创建/轮换一次 | 控制台创建密钥 |
| 作用域 | `middleware/auth.ts` `assertScopes` | `memories:read` / `memories:write` / `admin`（admin 隐含读写） | HTTP 测试 |
| 角色 | `requireConsoleRole` | 组织角色 owner/admin/developer/viewer | HTTP 测试 |
| 租户/分区隔离 | 所有查询带 `partition_id` | 分区 key 越权、跨组织统一 404 | HTTP 测试 |
| 限流 | `middleware/auth.ts` | 每 Key 每分钟；`X-RateLimit-Limit/Remaining/Reset`；429 + `Retry-After` | 手工 / `perf-persons` 压测 |
| 登录锁定 | `routes/auth.ts` | 连续失败 5 次后锁定 15 分钟（第 5 次 401，之后 423）；登录接口 30 次/分钟/IP | HTTP 测试 |
| 安全响应头 | `middleware/security.ts` | CSP、XFO DENY、nosniff、Referrer-Policy、Permissions-Policy、COOP/CORP；HSTS 可选 | `curl -I` |
| CORS | `middleware/cors.ts` | 仅回显本机来源 | `curl -H 'Origin: …'` |
| 请求上限/超时 | `env.bodyLimitBytes` / `middleware/timeout.ts` | 至少 1MB 请求体；30s 超时 | 手工 |
| 输入校验 | zod schemas（`http/schemas.ts`、`routes/v1.ts`） | 类型/长度/枚举/上限（content ≤20000、tags ≤20 等） | 单测 |
| SQL 参数化 | 全部 `db.prepare(...).run/get/all` | 无字符串拼接值；表名/列名为常量 | Code review |
| 配额 | `platform/quota.ts` | 分区月 token 配额；429 `QUOTA_EXCEEDED` + `Retry-After` | 单测/手工 |
| 审计 | `lib/audit.ts` + 引擎 | 登录、密钥、分区/人/记忆写、做梦、备份/维护、账号管理 | 控制台审计页 |
| 密钥生命周期 | `routes/console.ts` / `routes/org.ts` | 创建（scopes/限流/过期/IP）、轮换（立即吊销旧 key）、吊销 | 手工流程 |
| 备份 | `platform/backup.ts` | `VACUUM INTO`；保留 14 份；admin-only；文件名白名单 | 手工 + 恢复演练 |
| 优雅停机 | `main.ts` | SIGTERM → 停止接新连接 → drain → checkpoint → 关闭 | `kill -TERM` |
| 配置自检 | `env.ts` `validateEnv`/`assertEnv` | 生产禁 `AUTH_DISABLED`；目录可写；端口/超时/日志级别合法 | 启动失败即退出 |

---

## 4. 密钥生命周期

### 4.1 创建

控制台「分区 · 密钥」或 API（分区 admin+）：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4380/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@mnemos.dev","password":"Demo123456"}' | jq -r .token)

curl -s -X POST "http://127.0.0.1:4380/api/partitions/<partition>/keys" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "ci-readonly",
    "scopes": ["memories:read"],
    "rateLimitPerMin": 300,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "allowedIps": ["10.0.0.0/8"]
  }' | jq '{id, prefix, secret, scopes}'
```

要点：

- **明文 `secret` 只出现一次**，立即写入密钥管理系统（Vault/KMS/CI Secret）。
- 作用域最小化；只读 Agent 不给 `memories:write`，更不要给 `admin`。
- 生产密钥设置 `expiresAt` 与 `allowedIps`。
- 组织级 key（`kind=org`）只能由组织 owner 在任一分区的「密钥」页（组织密钥区块）创建/吊销；
  它可访问本组织任意分区，**不要下发给单个业务方**。

### 4.2 轮换

```bash
curl -s -X POST "http://127.0.0.1:4380/api/partitions/<partition>/keys/<keyId>/rotate" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"graceHours": 0}' | jq '{id, prefix, secret}'
```

- v6 轮换会**立即吊销旧 key**（`graceHours` 仅进审计），没有新旧并存的宽限窗口；
  需要灰度时由调用方先切新 key 再吊销旧 key。
- 审计动作：`key.rotate`。

### 4.3 吊销

```bash
curl -s -X DELETE "http://127.0.0.1:4380/api/partitions/<partition>/keys/<keyId>" \
  -H "authorization: Bearer $TOKEN"
```

- 吊销后立即 `401 API_KEY_REVOKED`；审计 `key.revoke`。

### 4.4 账号与会话

- 改密：`PATCH /api/auth/password`（需当前密码；新密码 ≥10 位且含字母+数字；
  成功后删除该用户其他会话）。
- 管理员重置：`POST /api/org/users/:id/reset-password`（一次性临时密码 + 清理会话）。
- 登录失败达到阈值（默认 5 次）后锁定 15 分钟：第 5 次响应 401（`details.locked=true`），
  之后的尝试返回 423 `account_locked`。锁定存于 `users.locked_until`，重启不丢；解锁：

  ```bash
  sqlite3 data-v6/mnemos.db "UPDATE users SET locked_until=NULL, failed_login_attempts=0 WHERE email='admin@example.com';"
  ```

- 角色变更/禁用立即生效（每请求实时查库）。

---

## 5. 数据保护与备份

- 数据库：`$MNEMOS_DATA_DIR/mnemos.db`（含 `-wal` / `-shm`）；目录 0700，属主为运行用户。
- 在线备份：`POST /api/ops/backup`（admin+），`VACUUM INTO`，不锁库，保留 14 份。
- 下载：`GET /api/ops/backups/:file`（admin+，文件名白名单，防路径穿越）。
- **应用不加密备份**。生产要求：备份目录 0700；异地上传前用 age/GPG/KMS 加密；
  按合规要求保留/删除；每月恢复演练。
- **可选字段加密**：`MNEMOS_ENCRYPTION_KEY` 配置后 `memory_attachments.url` 以
  AES-256-GCM（`v1:iv:tag:cipher`）落库；不加密 `memories.content`（保护 FTS/embedding/去重）。
  密钥必须与备份分开管理并可恢复，否则旧附件 URL 不可解密。
- 恢复流程见 [operations.md](operations.md)「数据与备份」。

---

## 6. 审计与日志

审计事件（v6 代码实际写入）：

```
auth.login / auth.login_failed / auth.logout / auth.password_changed
key.create / key.rotate / key.revoke
org.key_create / org.key_revoke
partition.upsert / partition.update
person.upsert / person.update
memory.add / memory.update / memory.delete
dream.run
ops.maintenance
org.user_create / org.user_reset_password
seed.demo（仅演示数据）
```

审计字段：`actor_type/id/label`、`action`、`resource_type/id`、`detail`、`ip`、`user_agent`、`created_at`。
查询：控制台「分区 · 审计」或 `GET /api/partitions/:p/audit?limit=50`（游标分页）。

结构化日志（JSON）示例：

```json
{"ts":"2026-11-17T16:01:05.801Z","level":"info","msg":"http.request","method":"POST","path":"/v1/partitions/mnemos-dev/persons/docs-user/memories","status":201,"latencyMs":3,"requestId":"req_ab12","ip":"127.0.0.1","route":"/v1/partitions/:partition/persons/:person/memories","actor":"API Key · docs"}
```

- 敏感字段（authorization/password/apikey/secret/token/cookie/credential）递归替换为 `[REDACTED]`。
- 慢请求（>1s）`warn`，5xx `error`；用 `requestId` 关联响应头 `x-request-id`。

---

## 7. 安全基线检查

**注意**：v5 时代的黑盒脚本已删除；v6 用 `scripts/preflight.ts` 与下文基线，兼容性差异：
`/v1/stats`，并使用 v5 演示账号），**尚未适配 v6**，不要把它的结果当作 v6 基线。

v6 手动基线（对一次性实例执行，避免锁定真实账号）：

```bash
BASE=http://127.0.0.1:4398

# 1) 安全响应头
curl -sI "$BASE/" | grep -Ei 'content-security-policy|x-frame-options|x-content-type|referrer-policy|permissions-policy'

# 2) 未认证：控制台与 v1 都应 401
curl -s -o /dev/null -w 'api=%{http_code}\n' "$BASE/api/partitions"
curl -s -o /dev/null -w 'v1=%{http_code}\n'  "$BASE/v1/partitions"

# 3) 分区 key 越权：访问其他分区应 404，建分区应 403
curl -s -o /dev/null -w 'other=%{http_code}\n' "$BASE/v1/partitions/<other>/stats" -H "authorization: Bearer $PARTITION_KEY"
curl -s -o /dev/null -w 'create=%{http_code}\n' -X POST "$BASE/v1/partitions" \
  -H "authorization: Bearer $PARTITION_KEY" -H 'content-type: application/json' -d '{"slug":"nope"}'

# 4) 限流：短时间 >limit 次请求，观察 X-RateLimit-* 与 429
for i in $(seq 1 60); do curl -s -o /dev/null -D - "$BASE/v1/partitions/<p>/stats" -H "authorization: Bearer $LOW_LIMIT_KEY" | grep -i x-ratelimit-limit; done | head

# 5) 探针/指标
curl -fsS "$BASE/healthz"; curl -fsS "$BASE/readyz"; curl -fsS "$BASE/metrics" | head

# 6) 登录锁定：连续 5 次错误密码后锁定（第 6 次起 423；会锁定测试账号，务必用一次性实例）
for i in $(seq 1 5); do curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -d '{"email":"admin@mnemos.dev","password":"wrong"}'; done
```

期望：1 有 CSP/XFO/nosniff；2 为 401；3 为 404/403；4 出现限流头并可 429；
5 全 200；6 第 1–5 次 401、第 6 次起 423。

---

## 8. 事件响应清单

> 原则：先遏制、再取证、后恢复；所有操作留痕（审计/日志/工单）。

### 8.1 发现

- 告警来源：5xx 比例、p95 延迟、429/auth_failures 突增、磁盘水位、备份/维护失败、异常登录。
- 快速确认：

  ```bash
  curl -fsS http://127.0.0.1:4380/healthz
  curl -fsS http://127.0.0.1:4380/readyz | jq .
  curl -fsS http://127.0.0.1:4380/api/ops/status -H "authorization: Bearer $TOKEN" | jq '.metrics'
  ```

### 8.2 遏制（按优先级）

1. **疑似密钥泄漏**：吊销相关 key、创建新 key（`DELETE /api/partitions/:p/keys/:id`），
   检查 `usage_events` 与审计。
2. **账号失陷**：重置密码（清理会话）、降权或禁用、检查 `user_sessions` 的 IP/UA。
   ```bash
   sqlite3 data-v6/mnemos.db "SELECT user_id, ip, user_agent, created_at FROM user_sessions ORDER BY created_at DESC LIMIT 20;"
   ```
3. **被刷/被打**：临时调低 Key 限流或吊销 Key；反代层封禁来源；不要用关指标止血。
4. **数据被篡改/误删**：停止写入（停服），立即备份当前库，再从最近完好备份恢复
   （会丢失备份点之后的数据）。
5. **主机失陷**：隔离主机、保留磁盘镜像、从干净镜像重建并恢复备份。

### 8.3 取证

- 保留：`mnemos.db`（含 WAL）、备份、应用日志、反代日志、`x-request-id` 关联链路。
- 导出审计：

  ```bash
  sqlite3 -readonly data-v6/mnemos.db \
    "SELECT created_at, actor_label, action, resource_type, resource_id, ip FROM audit_logs ORDER BY created_at DESC LIMIT 200;"
  ```

- 记录时间线：发现时间、操作人、命令、影响范围。

### 8.4 恢复与复盘

- 恢复后用 `/readyz`、`/health`、关键列表/搜索、手动基线（第 7 节）验证。
- 24h 内出复盘：根因、影响、检测缺口、改进项（负责人/截止时间）。
- 把新攻击面补充进本文威胁模型，并增加对应检查。

---

## 9. 未验证项与已知缺口

| 项 | 状态 |
| --- | --- |
| Docker 镜像构建/运行 | 本机无 Docker，未真机验证 |
| 生产 TLS / HSTS | 由反向代理提供；`MNEMOS_HSTS` 默认 0 |
| 备份加密 / 自动定时备份 | 应用不加密、无内置 cron；需外部工具/定时任务 |
| OIDC/SSO、SCIM | 未实现 |
| 镜像签名 / SBOM / 漏洞扫描 | 未接入 |
| 多副本、集中密钥管理 | 未实现（单节点假设） |
| v6.1 黑盒安全脚本 | `preflight.ts` + 第 7 节手工基线 |
| 登录锁定探测 | 会锁定测试账号 15 分钟；务必对一次性实例执行 |
