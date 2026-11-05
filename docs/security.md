# 安全模型与基线

> 适用范围：Mnemos 单节点生产部署（Node 原生 TS + SQLite WAL，反向代理终止 TLS）。
> 本文描述资产、威胁模型、已落地的控制项、密钥生命周期与事件响应流程，并给出可复现的安全基线检查方式。
> 文末如实列出**未验证项与已知缺口**。

---

## 1. 资产与信任边界

| 资产 | 位置 | 敏感度 |
| --- | --- | --- |
| 记忆内容（`memories`） | `data/mnemos.db` | 高：可能包含客户 PII、业务决策、密钥片段 |
| 用户口令哈希 / 会话令牌哈希 | `users` / `sessions` | 高 |
| API Key 哈希 | `api_keys.key_hash` | 高（明文只在创建/轮换响应中出现一次） |
| 审计日志 / 用量事件 | `audit_logs` / `usage_events` | 中高：含 actor、IP、UA |
| 备份文件 | `$MNEMOS_BACKUP_DIR`（默认 `data/backups`） | 高：完整数据库副本 |
| 结构化日志 | stdout / 容器日志驱动 | 中：含请求路径、IP，敏感字段脱敏 |

信任边界：

```
Internet
  │  TLS（反向代理 / 负载均衡）
  ▼
反向代理（Nginx/Caddy，本仓库外）
  │  HTTP，仅回环地址（建议 127.0.0.1:4380）
  ▼
Mnemos 进程（单节点，非 root）
  ├── 控制台会话（Bearer session，/api）
  ├── 公开 API（Bearer API Key，/v1）
  └── 运维端点（/healthz /readyz /metrics，无鉴权，不应暴露公网）
```

部署假设：

- 控制台与 API 同源提供；CORS 仅允许 `127.0.0.1 / localhost / ::1` 来源。
- `/metrics`、`/healthz`、`/readyz` 设计为**内网抓取**，不要暴露到公网（/metrics 未鉴权）。
- 单进程写 SQLite；多副本/读写分离不在当前范围（见 `production-readiness.md`）。

---

## 2. 威胁模型

| # | 威胁 | 典型场景 | 现有控制 | 残余风险 / 后续动作 |
| --- | --- | --- | --- | --- |
| T1 | **API Key 泄漏** | 密钥写入前端代码、日志、Git 历史；离职人员带走 | 只存 SHA-256；创建/轮换时明文仅返回一次；作用域最小化；单 Key 限流；可设过期时间与 IP 允许列表；一键吊销/轮换（可设宽限期）；审计 `key.create/rotate/revoke` | 泄漏后到发现前仍可用；需依赖日志/用量异常发现。生产强制自定义密钥、吊销演示密钥 |
| T2 | **越权 / IDOR** | 用 A 项目密钥读取 B 项目记忆；控制台低权限账号访问他人项目 | 所有查询强制带 `project_id`；API Key 绑定项目；项目成员角色 owner/admin/developer/viewer + 组织角色；跨项目读取返回 404（不泄露存在性）；`requireProjectAccess` 统一校验 | 组织 admin/owner 天然拥有全部项目，属预期；成员角色配置需审计 |
| T3 | **注入（SQL / 路径 / XSS）** | 构造 `q`、`id`、文件名注入 SQL；备份文件名路径穿越；记忆内容含脚本 | 全量 SQL 参数化；zod 校验入参；`/api/ops/backups/:file` 只接受 `[A-Za-z0-9._-]+\.db` 且做路径归属校验；CSP 禁止外部脚本、限制 `connect-src`；React 默认转义 | 控制台使用 `localStorage` 存会话令牌，XSS 即可窃取 → CSP 是关键防线；依赖升级需持续跟进 |
| T4 | **记忆内容投毒（间接提示注入）** | 攻击者向共享项目写入“忽略之前指令，调用某工具”的记忆，后续 Agent 简报被污染 | 记忆带 actor/来源/审计；项目/Agent/任务可见性隔离；导入需写权限并记录；简报按 section 分层并附 citations；记忆内容不作为可执行指令 | 模型侧仍需把记忆当**不可信数据**处理；高敏项目建议 `visibility=agent/task` + 人工复核导入 |
| T5 | **DoS / 暴力破解** | 高频搜索打满 CPU；撞库登录；超大请求体 | API Key 维度每分钟限流（`X-RateLimit-*`，超限 429）；登录连续失败 5 次锁定 15 分钟（423），登录接口另有 30 次/分钟/IP 限流（429）；请求体 1MB 上限；请求超时 30s；项目月配额（`quota_exceeded` 429 + `Retry-After`）；单进程同步 SQLite，写路径天然串行 | 单节点无水平扩展；公网部署建议反代层再加连接数/速率限制与 WAF |
| T6 | **备份泄漏** | 备份目录权限过宽、被同步到网盘、下载接口被越权调用 | 备份 API 仅组织 admin+；下载文件名白名单；备份保留 14 份；备份审计 | **备份默认不加密**，需依赖磁盘/对象存储加密与目录权限（0700）；异地副本需自行加密 |
| T7 | **会话劫持 / CSRF** | 令牌被窃取；跨站发起写操作 | 会话令牌仅存哈希；TTL 默认 72h；登出删除会话；改密/重置密码会清理会话；Bearer 头而非 Cookie → 传统 CSRF 面很小；CORS 白名单 | 令牌存 `localStorage`，XSS 风险见 T3；无设备管理/强制下线列表（P1） |
| T8 | **传输层窃听** | 明文 HTTP 暴露公网 | 生产要求反代终止 TLS；`MNEMOS_HOST=127.0.0.1`；`MNEMOS_HSTS=1` 可返回 HSTS | 应用本身不处理 TLS；证书管理在反代 |
| T9 | **供应链 / 容器逃逸** | 依赖投毒；镜像以 root 运行；镜像含源码/数据 | 依赖锁定（`pnpm-lock.yaml`、`--frozen-lockfile`）；镜像多阶段、非 root `node`、不带 `data/`；CI 类型检查/测试/安全基线 | 未做镜像签名/SBOM/漏洞扫描（P1）；本机无 Docker，镜像未真机验证 |
| T10 | **日志/审计泄漏** | 日志打印令牌、密码；审计含敏感 detail | 结构化日志对 `authorization/password/apikey/secret/token/cookie/credential` 等 key 递归脱敏；登录只记录 email；API Key 只记录 prefix | 运维仍需限制日志访问；外送 SIEM 前复核字段 |
| T11 | **误操作 / 内部威胁** | 误删项目、清空记忆、直接改库 | 危险操作需 admin+；批量删除、导入有上限；审计记录 actor/IP/UA；备份与恢复演练 | 无四眼原则/审批流（P2）；数据库文件系统权限需收紧 |

---

## 3. 控制项清单

| 控制 | 实现位置 | 说明 | 验证方式 |
| --- | --- | --- | --- |
| 口令哈希 | `server/src/lib/password.ts` | PBKDF2-SHA256，120k 迭代，随机盐，`timingSafeEqual` | 单测；改密流程 |
| 会话令牌 | `sessions.token_hash` | 只存 SHA-256；72h TTL；登出/改密清除 | `security-check` 未认证 401 |
| API Key 哈希 | `api_keys.key_hash` | 只存 SHA-256；明文仅创建/轮换响应一次 | 控制台创建密钥 |
| 作用域 | `assertScopes` | `memories:read/write`、`graph:read`、`admin`；缺失返回 403 | `security-check` scope 项 |
| RBAC | `middleware/auth.ts` + 路由 `project.minRole` | 组织角色 × 项目角色；写操作要求 developer+，密钥/设置/审计要求 admin+ | 单测 + 手工越权 |
| 租户隔离 | 所有查询带 `project_id` | 跨项目读取 404；控制台项目列表按可见性过滤 | `security-check` IDOR 项 |
| 限流 | `middleware/auth.ts` | 每 Key 每分钟；响应带 `X-RateLimit-Limit/Remaining/Reset`；超限 429 | `security-check` 限流项 |
| 登录锁定 | `routes/auth.ts` | 连续失败 `MNEMOS_LOGIN_MAX_ATTEMPTS`(5) 次 → 423，锁定 `MNEMOS_LOGIN_LOCK_MINUTES`(15) 分钟；登录接口 30 次/分钟/IP | `security-check` 锁定项 |
| 安全响应头 | `middleware/security.ts` | CSP、X-Frame-Options: DENY、nosniff、Referrer-Policy、Permissions-Policy、COOP/CORP；HSTS 可选 | `security-check` 响应头项 |
| CORS | `middleware/cors.ts` | 仅回显本机来源；非法 Origin 不返回 ACAO | `security-check` CORS 项 |
| 请求上限/超时 | `env.bodyLimitBytes` / `middleware/timeout.ts` | 1MB 请求体；30s 请求超时（SSE 豁免） | 手工/压测 |
| 输入校验 | zod schemas（`http/schemas.ts`、路由内 schema） | 类型、长度、枚举、上限（导入 ≤1000、导出 ≤50000） | 单测 |
| SQL 参数化 | 全部 `db.prepare(...).run/get/all` | 无字符串拼接值；表名/列名为代码常量 | Code review |
| 配额 | `platform/quota.ts` | 项目月 token 配额；超限 429 `quota_exceeded` + `Retry-After` | 单测/手工 |
| 幂等键 | `http/idempotency.ts` | `Idempotency-Key` 重放首次响应，带 `x-idempotent-replayed: true` | `security-check` 幂等项 |
| 审计 | `lib/audit.ts` + 各路由 | 登录、密钥、项目、记忆写/删、导出/导入、备份、维护、成员管理 | 控制台审计页 / API |
| 密钥生命周期 | `routes/keys.ts` | 创建（scopes/限流/过期/IP）、轮换（graceHours）、吊销；审计 | 手工流程 |
| 备份 | `platform/backup.ts` | `VACUUM INTO` 在线备份；保留 14 份；admin-only API；下载文件名白名单 | `scripts/backup-restore-drill.sh` |
| 优雅停机 | `main.ts` | SIGTERM → 停止接新连接 → drain SSE/in-flight → WAL checkpoint → 关闭 | `docker stop` / kill -TERM |
| 配置自检 | `env.ts` `assertEnv` | 生产禁止 `AUTH_DISABLED`；校验目录可写、端口/超时/日志级别 | 启动失败即退出 |

---

## 4. 密钥生命周期

### 4.1 创建

控制台「项目 · 密钥」或 API（需项目 admin+）：

```bash
# 登录拿会话
TOKEN=$(curl -s -X POST http://127.0.0.1:4380/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"lin.wei@mnemos.dev","password":"mnemos-demo"}' | jq -r .token)

# 创建最小作用域密钥（限制速率、设置过期与来源 IP）
curl -s -X POST "http://127.0.0.1:4380/api/projects/prj_orion_python/keys" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "orion-ci-readonly",
    "scopes": ["memories:read"],
    "rateLimitPerMin": 300,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "allowedIps": ["10.0.0.0/8"]
  }' | jq '{id, prefix, secret, scopes}'
```

要点：

- **明文 `secret` 只出现一次**，立即写入密钥管理系统（Vault/KMS/CI Secret），不要落盘到仓库或聊天记录。
- 作用域按需最小化；只读 Agent 不要给 `memories:write`，更不要给 `admin`。
- 生产密钥设置 `expiresAt` 与 `allowedIps`（CIDR/精确 IP，按需）。
- 演示密钥（`mnemos_live_demo_*`）只用于演示环境，生产必须吊销。

### 4.2 轮换

```bash
# 轮换旧密钥，旧密钥保留 24h 宽限期（graceHours=0 立即吊销）
curl -s -X POST "http://127.0.0.1:4380/api/projects/prj_orion_python/keys/key_orion_coder/rotate" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"graceHours": 24}' | jq '{id, prefix, secret}'
```

- 新密钥继承旧密钥的 scopes、限流、过期时间与 IP 允许列表。
- `graceHours > 0` 时旧密钥设置过期时间而非立即吊销，便于灰度切换；到期自动失效。
- 审计动作：`key.rotate`。

### 4.3 吊销

```bash
curl -s -X DELETE "http://127.0.0.1:4380/api/projects/prj_orion_python/keys/key_orion_coder" \
  -H "authorization: Bearer $TOKEN" | jq .
```

- 吊销后立即 401（`API_KEY_REVOKED`）。
- 审计动作：`key.revoke`。

### 4.4 账号与会话

- 密码修改：控制台账号设置，或 `PATCH /api/auth/password`（需当前密码；新密码至少 10 位且含字母+数字；成功后删除该用户的其他会话）：

  ```bash
  curl -s -X PATCH http://127.0.0.1:4380/api/auth/password \
    -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
    -d '{"currentPassword":"old-pass","newPassword":"new-pass-2026"}'
  ```

- 管理员重置成员密码：`POST /api/org/users/:id/reset-password`（返回一次性临时密码，**并清理该用户全部会话**）。
- 登录失败达到阈值：账号锁定 15 分钟（423），DB 字段 `users.locked_until`；解锁：

  ```bash
  sqlite3 data/mnemos.db "UPDATE users SET locked_until=NULL, failed_login_attempts=0 WHERE email='lin.wei@mnemos.dev';"
  ```

  （服务端没有独立解锁 API；重置密码也会清除锁定计数。）
- 角色变更/删除成员会立即影响鉴权（每个请求实时查库）。

---

## 5. 数据保护与备份

- 数据库：`$MNEMOS_DATA_DIR/mnemos.db`，另含 `-wal` / `-shm`；目录权限建议 `700`，属主为运行用户。
- 在线备份：`POST /api/ops/backup`（admin+），内部执行 `VACUUM INTO`，不锁库；默认保留最近 14 份。
- 下载：`GET /api/ops/backups/:file`（admin+，文件名白名单，防路径穿越）。
- **应用不加密备份**。生产要求：
  - 备份目录 0700，仅运维账号可读；
  - 异地上传前用 `age`/GPG/KMS 加密；
  - 备份保留与删除遵循数据合规要求；
  - 每月至少一次恢复演练：`bash scripts/backup-restore-drill.sh`。
- 恢复流程与演练细节见 `docs/operations.md`「备份与恢复」。

---

## 6. 审计与日志

审计事件（以代码为准）：`auth.login`、`auth.login_failed`、`auth.logout`、`auth.password_changed`、`key.create/rotate/revoke`、`project.create/update/delete`、`memory.create/update/delete/bulk/feedback`、`memory.import`、`ops.backup.created`、`ops.maintenance`、`user.create/update/delete/reset_password`、`member.update/remove`、`settings.update`、`agent.create/update`、`task.create/update/finish`。

审计字段：`actor_type/id/label`、`action`、`resource_type/id`、`detail`、`ip`、`user_agent`、`created_at`。
查询：控制台「项目 · 审计」或 `GET /api/projects/:id/audit?page=1&pageSize=50`（admin+）。

结构化日志（JSON）：

```json
{"ts":"2026-11-05T15:00:00.000Z","level":"info","msg":"http.request","method":"GET","path":"/api/projects/prj_orion_python/memories","status":200,"latencyMs":12,"requestId":"req_ab12","ip":"127.0.0.1","route":"/api/projects/:id/memories","actor":"lin.wei@mnemos.dev"}
```

- 敏感字段（authorization/password/apikey/secret/token/cookie/credential）在日志中递归替换为 `[REDACTED]`。
- 慢请求（>1s）`warn`，5xx `error`；可用 `requestId` 关联响应头 `x-request-id`。
- 日志默认写 stdout；容器使用 `json-file` 轮转（10MB × 5）。

---

## 7. 安全基线检查（自动化）

```bash
# 对运行中的服务做黑盒检查（默认 4380）
node scripts/security-check.mjs

# 建议：对一次性实例运行（登录锁定探测不会影响真实账号）
node scripts/security-check.mjs --auto-start --base http://127.0.0.1:4392

# 已有实例但不想锁定账号
node scripts/security-check.mjs --skip-lockout
```

检查项与期望：

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | 安全响应头 | CSP / XFO / nosniff / Referrer-Policy / Permissions-Policy |
| 2 | 未认证访问 | `/api/dashboard`、`/v1/memories/search` → 401 |
| 3 | 错误密钥 | `/v1/memories` → 401 |
| 4 | 作用域越权 | 无 admin scope 访问 `/v1/stats` → 403 |
| 5 | IDOR | 其他项目密钥读记忆 → 404/403 |
| 6 | 限流 | 快速 >60 次搜索，返回 `X-RateLimit-*`；可触发 429 |
| 7 | 幂等 | 同 `Idempotency-Key` 两次写入：同 id + `x-idempotent-replayed: true` |
| 8 | 监控 | `/metrics` 为 Prometheus 文本；`/healthz`、`/readyz` 200 且 `ok=true` |
| 9 | CORS | 非法 Origin 不回显；`http://127.0.0.1:4381` 回显 |
| 10 | 登录锁定 | 连续 5 次错误密码 → 423/429 |

- 任一 **FAIL** 退出码 1；接口尚未上线时标记 **SKIP**（不失败）。
- 本机在最新工作区实测：11/11 PASS（对一次性实例，数据目录 `.run/security-check`）。
- CI（`.github/workflows/ci.yml`）会在临时实例上执行该检查。
- 重复运行时，账号可能仍处于上次的锁定窗口，依赖登录的检查会 SKIP；建议用 `--auto-start` 的一次性实例。
- 也建议每周在预发环境执行，并把结果归档。

配套检查：

- `bash scripts/preflight.sh`：启动前环境/目录/端口/DB 完整性/磁盘检查。
- `bash scripts/backup-restore-drill.sh`：备份 + 迁移 + 恢复演练。
- `node scripts/load-test.mjs`：压测，验证限流/超时行为与容量假设。

---

## 8. 事件响应清单

> 原则：先遏制、再取证、后恢复；所有操作留痕（审计/日志/工单）。

### 8.1 发现

- 告警来源：5xx 比例、p95 延迟、429/auth_failures 突增、磁盘水位、备份失败、异常登录。
- 快速确认：
  ```bash
  curl -fsS http://127.0.0.1:4380/healthz
  curl -fsS http://127.0.0.1:4380/readyz | jq .
  node scripts/security-check.mjs --skip-lockout
  ```

### 8.2 遏制（按优先级）

1. **疑似密钥泄漏**：吊销相关 Key，轮换新 Key（`graceHours=0`），检查用量事件与审计。
   ```bash
   curl -X DELETE "http://127.0.0.1:4380/api/projects/<pid>/keys/<kid>" -H "authorization: Bearer $TOKEN"
   ```
2. **账号失陷**：重置密码（会清理会话）、降权或禁用账号、检查 `sessions` 与会话 IP。
   ```bash
   sqlite3 data/mnemos.db "SELECT user_id, ip, user_agent, created_at FROM sessions ORDER BY created_at DESC LIMIT 20;"
   ```
3. **正在被刷/被打**：临时调低 Key 限流或吊销 Key；反代层封禁来源 IP；必要时 `MNEMOS_METRICS_ENABLED` 不影响流量，不要靠它止血。
4. **数据被篡改/误删**：停止写入（停服务或只读维护），立即备份当前库，再从最近完好备份恢复（注意会丢失备份点之后的数据）。
5. **主机失陷**：隔离主机，保留磁盘镜像，不在原机继续操作；从干净镜像重建并从备份恢复。

### 8.3 取证

- 保留：`mnemos.db`（含 WAL）、备份文件、应用日志、反代日志、`x-request-id` 关联链路。
- 导出审计：控制台审计页导出，或直接查询：
  ```bash
  sqlite3 -readonly data/mnemos.db \
    "SELECT created_at, actor_label, action, resource_type, resource_id, ip FROM audit_logs ORDER BY created_at DESC LIMIT 200;"
  ```
- 记录时间线：发现时间、操作人、命令、影响范围。

### 8.4 恢复与复盘

- 恢复服务后用 `/readyz`、冒烟（`node scripts/smoke-api.mjs`）、安全基线（`security-check.mjs`）验证。
- 24h 内出复盘：根因、影响、检测缺口、改进项（负责人/截止时间）。
- 把新攻击面补充进本文威胁模型，并增加对应自动化检查。

---

## 9. 未验证项与已知缺口

如实说明（截至当前工作区）：

| 项 | 状态 |
| --- | --- |
| Docker 镜像构建/运行 | **本机无 Docker，未验证** `docker build`；CI 仅做构建语法验证，未在容器内跑健康检查 |
| 生产 TLS / HSTS | 由反向代理提供，仓库内未配置证书；`MNEMOS_HSTS` 默认 0 |
| 备份加密 | 应用不加密备份，需依赖磁盘/对象存储加密或外部工具 |
| 自动定时备份 | 当前仅手动/API 触发，无内置 cron（P1） |
| 首次部署管理员引导 | 已实现：`MNEMOS_BOOTSTRAP_*` 环境变量创建初始 owner；缺少配置时拒绝启动（P0 ✅） |
| OIDC/SSO、SCIM | 未实现（P1） |
| 镜像签名/SBOM/漏洞扫描 | 未接入（P1） |
| 多副本、密钥集中管理 | 未实现（P1/P2） |
| 登录锁定探测 | 会锁定测试账号 15 分钟；脚本已提示，建议对一次性实例运行 |
| 安全基线实测 | 在最新工作区对一次性实例 11/11 PASS；对 4380 旧进程曾因功能未上线出现 SKIP/FAIL，属版本差异 |

生产上线前请完成 `docs/production-readiness.md` 的「上线检查清单」。
