# 大模型设置（v6.4 / schema v10）

> 目标：把「一个全局 LLM」升级为**供应商 + 按阶段分配模型**。不同阶段按所需智能程度选不同模型 /
> 温度 / 输出上限，以降低成本；后端**直连 OpenAI 兼容 / Anthropic API**，不依赖 DSH（DSH 插件
> 只是记忆客户端，DSH 自己的模型配置与本服务无关）。
>
> - 实现：`server/src/engine/llm.ts`（协议与路由）、`server/src/engine/llm-settings.ts`
>   （供应商 / 阶段 / 用量 / 测试连接）、schema v10 的 `llm_providers` / `llm_stage_configs` /
>   `llm_calls`。
> - 契约类型：`shared/src/types.ts` 的 `LlmProvider` / `LlmStageConfig` / `LlmUsageSummary` / `LlmStatus`。
> - 控制台：组织设置 → **模型设置**（`/org/models`），见第 9 节。
> - 环境变量回退：`MNEMOS_LLM_BASE_URL` + `MNEMOS_LLM_API_KEY` + `MNEMOS_LLM_MODEL`（兼容 v6.3）。

---

## 1. 能力与边界

| 能力 | 说明 |
| --- | --- |
| 多供应商 | 任意多个 OpenAI 兼容 / Anthropic 供应商；同名唯一，可单独启停 |
| 按阶段分配 | `brief` / `dream` / `profile` / `privacy` / `extract` 五个阶段各自绑定供应商、模型、温度、`maxTokens`、超时、系统提示词 |
| 直连 API | 服务端直接 `fetch` 供应商；不经过 DSH、不需要 OpenAI SDK |
| 密钥保护 | `MNEMOS_ENCRYPTION_KEY` 存在时用 AES-256-GCM 加密落库；API 只返回 `hasApiKey` / `apiKeyMasked` |
| 测试连接 | 对单个供应商发最小请求，返回 `ok / latencyMs / model / error` |
| 用量/成本 | `llm_calls` 记录每次调用的 stage/provider/model/协议/tokens/耗时/状态；按 1M token 单价估算成本 |
| 安全降级 | 未配置 / 超时 / 非 2xx / 结构异常 → 返回空串，调用方回退确定性逻辑，绝不阻断主流程 |

**边界**（刻意的）：

- LLM 只用于「增强」：简报润色、洞见归并、画像摘要、prompt 隐私抽取。规则实体抽取、检索、
  去重、计数、写入等核心路径**不依赖 LLM**。
- 不记录 prompt / 响应正文：`llm_calls` 只存结构化元数据（见第 7 节）。
- 供应商与阶段配置是**组织级**设置（`/api/llm/*`，控制台 admin+）；公开 `/v1` API Key 不能读写。
- 不做自动模型发现 / 余额查询；模型名由运维填写，价格由运维按账单填写。

---

## 2. 数据模型

```ts
type LlmProtocol = 'openai' | 'anthropic';
type LlmStage = 'brief' | 'dream' | 'profile' | 'privacy' | 'extract';

interface LlmProvider {
  id: string;                // llm_…
  name: string;              // 唯一（同组织）
  protocol: LlmProtocol;
  baseUrl: string;           // 不带尾斜杠；拼接规则见 4.3 节
  defaultModel?: string;
  hasApiKey: boolean;        // 永不返回明文
  apiKeyMasked?: string;     // 前 3 + … + 后 4；短 key 显示 ••••
  inputPrice: number;        // $ / 1M prompt tokens（0 表示未填）
  outputPrice: number;       // $ / 1M completion tokens
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LlmStageConfig {
  stage: LlmStage;
  providerId?: string;       // 空 = 该阶段未绑定供应商
  model?: string;            // 空 = 用 provider.defaultModel
  temperature: number;       // 0–2，默认 0.2
  maxTokens: number;         // 1–8192，默认 1024
  timeoutMs: number;         // 1000–120000，默认 20000
  systemPrompt?: string;     // 空 = 用内置提示词
  enabled: boolean;          // 默认 true；false = 该阶段不调 LLM
  updatedAt?: string;
}

interface LlmUsageSummary {
  stage: LlmStage;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;     // 美元；见第 7 节公式
}

interface LlmStatus {
  envFallbackConfigured: boolean; // env 的 baseUrl + apiKey + model 齐全
  providers: number;              // 供应商总数（含禁用）
  stages: number;                 // 已保存的阶段配置行数（0–5）
  encryptionConfigured: boolean;  // 是否配置 MNEMOS_ENCRYPTION_KEY
}
```

### 2.1 表结构（schema v10，`server/src/db/schema.sql`）

```sql
CREATE TABLE IF NOT EXISTS llm_providers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  protocol           TEXT NOT NULL DEFAULT 'openai',
  base_url           TEXT NOT NULL,
  default_model      TEXT,
  api_key_cipher     TEXT NOT NULL DEFAULT '',
  api_key_encrypted  INTEGER NOT NULL DEFAULT 0,
  input_price        REAL NOT NULL DEFAULT 0,
  output_price       REAL NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_stage_configs (
  stage         TEXT PRIMARY KEY,
  provider_id   TEXT,
  model         TEXT,
  temperature   REAL NOT NULL DEFAULT 0.2,
  max_tokens    INTEGER NOT NULL DEFAULT 1024,
  timeout_ms    INTEGER NOT NULL DEFAULT 20000,
  system_prompt TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                TEXT PRIMARY KEY,
  stage             TEXT NOT NULL,
  provider_id       TEXT,
  model             TEXT,
  protocol          TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_stage ON llm_calls(stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
```

- `llm_providers`：供应商。`api_key_cipher` 只在配置密钥时是 `v1:<iv>:<tag>:<cipher>` 密文，
  否则原样明文；`api_key_encrypted=0` 表示当前列不是密文。`id` 前缀为 `llm_`。
- `llm_stage_configs`：以 `stage` 为主键的稀疏表。没有行时 `GET /api/llm/stages` 用默认值
  （0.2 / 1024 / 20000）补全展示；但**路由只认已保存的行**，无行即回退 env。
- `llm_calls`：调用流水，**只增不改**；索引按阶段与时间支持用量聚合。
- 外键是逻辑引用（SQLite 未声明 `FOREIGN KEY`）：删除供应商时会把阶段配置里的 `provider_id`
  置空（避免指向幽灵 id），阶段保留其余设置；运行时按「未绑定供应商」回退 env，可在控制台重新选择。

---

## 3. 阶段与默认参数

| 阶段 | 用途 | 调用点 | 默认 temperature | 默认 maxTokens | 默认 timeout | 内置提示词 |
| --- | --- | --- | --- | --- | --- | --- |
| `brief` | 人级 / 分区级**简报润色** | `engine/brief.ts` | 0.2 | 1024 | 20000ms | 有；把确定性摘要润色为简洁自然语言，不新增事实 |
| `dream` | 做梦时**洞见归并润色** | `engine/dream.ts` | 0.2 | 1024 | 20000ms | 有；把多条记忆归并成一条 `category=insight` 洞见 |
| `profile` | 人**画像摘要** | `engine/profile.ts` | 0.2 | 1024 | 20000ms | 有；基于 facts + 最近记忆写 ≤800 字摘要 |
| `privacy` | **prompt 隐私规则**抽取 | `engine/privacy.ts`（`privacy` job / dream） | 0.2 | 1024 | 20000ms | 有；返回 `{entities:[{code,value}]}`，服务端校验 value 必须出现在原文 |
| `extract` | 预留 | 暂无调用点 | 0.2 | 1024 | 20000ms | 无 |

说明：

- 上表「默认」是**未配置阶段行**时 `GET /api/llm/stages` 展示的值；路由只认已保存的行
  （没有行就回退 env，不使用上表默认值）。
- 实际写入时建议 `privacy` 用 512，其余 1024；`maxTokens` 是**请求上限**（`max_tokens`），
  输出文本另会被调用方按业务长度裁剪（如简报 `maxChars`）。
- `privacy` 阶段若 `privacyLlmEnabled=false` 或 LLM 不可用，规则扫描会跳过 prompt 规则并静默回退 regex。
- `extract` 阶段在 v6.4 只做配置预留；规则实体抽取不使用 LLM。

### 3.1 恒定的协议行为

- 统一 `temperature` 传阶段值（不再固定 0.2）；`max_tokens` 传阶段值；超时用阶段 `timeoutMs`。
- `systemPrompt` 非空时覆盖内置提示词；支持多行文本，最长 8000 字符（控制台 textarea）。
- 请求失败（见第 6 节）返回空串 `''`；调用方拿到空串走确定性逻辑。

---

## 4. 协议与供应商示例

### 4.1 openai（OpenAI 兼容）

- 请求：`POST {baseUrl}/chat/completions`
- 头：`content-type: application/json`、`authorization: Bearer <apiKey>`
- 体：`{ model, messages: [{role:'system'|'user', content}], temperature, max_tokens }`
- 解析：`choices[0].message.content`（字符串）；usage 读 `usage.prompt_tokens` / `usage.completion_tokens`
- 非 2xx → `''`；2xx 但无 `choices` / content 非字符串 → 同样返回 `''`（调用方回退）。

### 4.2 anthropic

- 请求：`POST {baseUrl}/v1/messages`
- 头：`content-type: application/json`、`x-api-key: <apiKey>`、`anthropic-version: 2023-06-01`
- 体：`{ model, system?, messages: [{role:'user', content}], temperature, max_tokens }`
- 解析：`content[]` 中 `type=text` 的 `text` 拼接；usage 读 `usage.input_tokens` / `usage.output_tokens`
- `system` 是顶层字段，**不要**放进 messages。

### 4.3 baseUrl / model 对照

| 供应商 | protocol | baseUrl（填这个） | 实际请求地址 | 示例 model | 密钥 |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `openai` | `https://api.openai.com/v1` | `…/v1/chat/completions` | `gpt-4o-mini` / `gpt-4.1-mini` | 必填 |
| DeepSeek | `openai` | `https://api.deepseek.com/v1` | `…/v1/chat/completions` | `deepseek-chat` / `deepseek-reasoner` | 必填 |
| 通义千问（兼容模式） | `openai` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `…/compatible-mode/v1/chat/completions` | `qwen-plus` / `qwen-max` | 必填 |
| Ollama（本地） | `openai` | `http://127.0.0.1:11434/v1` | `…/v1/chat/completions` | `llama3.1:8b` / `qwen2.5:7b` | 任意占位（如 `ollama`） |
| vLLM（本地） | `openai` | `http://127.0.0.1:8000/v1` | `…/v1/chat/completions` | 部署的模型名（如 `Qwen/Qwen2.5-7B-Instruct`） | 若启用 `--api-key` 则填；否则占位 |
| Anthropic | `anthropic` | `https://api.anthropic.com` | `…/v1/messages` | `claude-sonnet-4-20250514` / `claude-3-5-haiku-latest` | 必填 |

> **baseUrl 不要带尾斜杠**；服务端会去掉末尾 `/` 后再拼接。OpenAI 兼容的 baseUrl 通常**要**带
> `/v1`（以 `/chat/completions` 结尾则原样使用）。Anthropic 建议填 `https://api.anthropic.com`
> （**不要**带 `/v1`）；为容错，服务端也会识别以 `/v1` 或 `/v1/messages` 结尾的写法，
> 不会拼出 `/v1/v1/messages`。
>
> 本地 Ollama / 未开鉴权的 vLLM 仍需填一个非空 `apiKey`（任意占位字符串）：空 key 会被视为
> 「供应商未配置」，该阶段回退环境变量或确定性逻辑。

### 4.4 直接 curl 验证（不经过 Mnemos）

```bash
# OpenAI 兼容
curl -s https://api.deepseek.com/v1/chat/completions \
  -H "authorization: Bearer $DEEPSEEK_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"ping"}],"max_tokens":8}'

# Anthropic
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-haiku-latest","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}'
```

先确保 curl 通，再在控制台「测试连接」；两步都失败时优先查网络/代理/密钥，而不是 Mnemos。

---

## 5. 密钥与加密

### 5.1 加密落库

- `MNEMOS_ENCRYPTION_KEY` 非空时，供应商 API Key 用 **AES-256-GCM** 加密后写入
  `llm_providers.api_key_cipher`，格式 `v1:<base64(iv)>:<base64(tag)>:<base64(cipher)>`，
  `api_key_encrypted=1`。
- 未配置该变量时**明文存储**（`api_key_encrypted=0`），仅适合本地开发；生产必须配置。
- 加密密钥由 `lib/crypto.ts` 统一派生（SHA-256 → 32 字节），与附件 URL / 占位符加密共用。
- **换密钥/丢密钥后旧密文无法解密**：`hasApiKey` 仍为 true（键还在），但 `apiKeyMasked` 为空、
  测试连接失败、阶段解析时视为无 key 回退 env。需要重新 PATCH 一次 API Key。
  不要在不备份密钥的情况下轮换。

### 5.2 掩码与读取语义

- API **永不返回明文**：列表/详情只有 `hasApiKey` 与 `apiKeyMasked`（前 3 位 + `…` + 后 4 位，
  如 `sk-…abcd`；短 key 显示 `••••`）。
- `hasApiKey` 表示**库里是否存有密钥**（即使当前无法解密也是 true）；若加密密钥丢失/不匹配，
  `apiKeyMasked` 会为空串，测试连接报「未配置 API Key（或无法解密…）」，此时重新 PATCH 一次即可。
- 数据库/备份文件仍含密文，按密钥材料同等保护（见 [operations](operations.md#9-大模型设置与密钥轮换v64)）。

### 5.3 更新语义

| 场景 | 请求 | 结果 |
| --- | --- | --- |
| 只改名称/价格/模型，不动密钥 | `PATCH`，省略 `apiKey` | 密钥保持原值 |
| 设置/更换密钥 | `PATCH`，`apiKey: "sk-新…"` | 覆盖并重新加密（`hasApiKey=true`） |
| 清除密钥 | `PATCH`，`clearApiKey: true` | 清空（`hasApiKey=false`）；与 `apiKey` 同时出现时以 `clearApiKey` 为准 |
| 新建时不填密钥 | `POST`，省略 `apiKey` | 允许创建（`hasApiKey=false`），测试连接会失败 |

- 响应中的 `apiKeyMasked` 只用于展示，不能用于回填；控制台编辑弹窗留空 = 不修改。
- 所有写操作写审计（`llm.provider.create/update/delete`、`llm.provider.test`、`llm.stage.update`），
  审计 detail 不含明文密钥。

---

## 6. 解析与失败降级（LlmRouter）

### 6.1 解析顺序

每次调用 `callLlm(stage, input)` 时按以下顺序解析（`createLlmRouter` 每次实时读 `llm_stage_configs` / `llm_providers`，配置改完即生效）：

1. **阶段配置**：`llm_stage_configs[stage]` 存在且 `enabled=true`
   → 解析 `providerId` → `llm_providers`；
   - 供应商存在且 `enabled=true`，`model = stage.model ?? provider.defaultModel`，
     `apiKey` 可解密/非空 → **使用阶段配置**；
   - 阶段 `enabled=false` → **不调 LLM**，返回 `''`（显式关闭，不回退 env，也不写 `llm_calls`）；
   - 阶段启用，但供应商不存在 / 无模型 / 无密钥 / 密钥不可解密 → 视为「配置未完成」，
     继续第 2 步回退环境变量；
   - 供应商存在但 `enabled=false` → **不调 LLM**，返回 `''`（显式禁用，**不回退 env**，不写 `llm_calls`）。
2. **环境变量回退**（兼容 v6.3）：`MNEMOS_LLM_BASE_URL` + `MNEMOS_LLM_API_KEY` 均非空
   → 以 `openai` 协议、`MNEMOS_LLM_MODEL`（默认 `gpt-4o-mini`）发请求。
   同时兼容 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 旧别名（优先级低于 `MNEMOS_LLM_*`）。
3. **都没有** → 返回 `''`，调用方走确定性逻辑。

> 判定「可用」的最短条件：`baseUrl` 非空、`apiKey` 非空、`model` 非空、协议合法。
> 任一不满足 → 该层不可用，继续下一层。
> 有可用的阶段行时，**env fallback 完全不参与**；阶段行的 `model` 优先于 `provider.defaultModel`。

### 6.2 失败降级

| 失败 | 行为 |
| --- | --- |
| 无阶段行且无 env / 阶段关闭 / 供应商禁用 | 不产生网络请求，返回 `''`，**不写 `llm_calls`** |
| 超时（`AbortSignal.timeout`） | 中止请求，返回 `''`，`llm_calls.status='timeout'`，`error='timeout <ms>ms'` |
| 非 2xx（401/403/404/429/5xx） | 不抛错，返回 `''`，`status='error'`，`error='HTTP <status>'` |
| 响应结构异常（无 content / JSON 解析失败） | 返回 `''`，`status='error'`，`error` 为解析异常短信息 |
| 成功但内容为空 | 返回 `''`（调用方仍走确定性兜底） |

- **绝不抛错到业务路径**：brief/dream/profile/privacy 在拿到 `''` 时使用原有确定性实现。
- 实际发起的失败会写 `llm_calls`（便于排障），但**不记录 prompt/响应正文**；`error` 只保留简短原因。
- 隐私 prompt 规则失败时直接跳过该条 prompt 规则，不影响 regex 扫描与记忆写入。

---

## 7. 用量与成本

### 7.1 记录

每次实际发起的调用（成功或失败）追加一条 `llm_calls`；**未发起请求**（阶段关闭、供应商禁用、
无可用配置）不记录：

| 字段 | 说明 |
| --- | --- |
| `stage` | brief/dream/profile/privacy/extract |
| `provider_id` / `model` / `protocol` | 实际使用的供应商、模型、协议；env 回退时 provider_id 为空 |
| `prompt_tokens` / `completion_tokens` | 供应商返回的 usage；缺失/失败为 0 |
| `duration_ms` | 网络请求耗时（毫秒） |
| `status` | `ok` / `error` / `timeout` |
| `error` | 失败原因摘要（如 `HTTP 401`、`timeout 20000ms`，≤500 字符），成功为空 |
| `created_at` | ISO 8601 UTC |

### 7.2 聚合与公式

`GET /api/llm/usage?days=30` 按阶段聚合，返回 `{ items, days }`（`LlmUsageSummary[]`）：

```
calls            = 窗口内全部调用数（含 error / timeout）
promptTokens     = Σ prompt_tokens
completionTokens = Σ completion_tokens
estimatedCost    = promptTokens / 1,000,000 × inputPrice
                 + completionTokens / 1,000,000 × outputPrice
```

- `items` **只包含有调用记录的阶段**（按 brief→dream→profile→privacy→extract 顺序），
  无调用的阶段不出现。
- 单价取该调用实际使用的供应商配置（env 回退的调用 cost 为 0，因为没有价格）。
- 结果四舍五入到 **6 位小数**（美元）；供应商价格是「$/1M tokens」，不要误填「$/1K」。
- 供应商删除后历史调用仍保留 `provider_id`/`model`，但价格按 0 计（无法回溯已删除配置）；
  成本对账请以供应商账单为准。

示例：`brief` 阶段 30 天 120 次成功调用，prompt 180,000、completion 60,000，
供应商 `gpt-4o-mini` 价格 `$0.15 / $0.60`：

```
prompt:     180000 / 1e6 × 0.15 = 0.027
completion:  60000 / 1e6 × 0.60 = 0.036
estimatedCost = 0.063   // ≈ $0.063
```

### 7.3 成本控制

- **小模型**跑 `privacy` / `brief`：这两条是高频、短输出、容错高（失败有确定性兜底）。
- **大模型**跑 `dream` / `profile`：低频、要求归并/抽象质量，值得用更强模型。
- 本地 Ollama/vLLM 可把 `privacy`/`brief` 价格填 0，成本只看 token；大模型仍走云。
- 给阶段设较小 `maxTokens`（如 privacy 512、brief 1024）能显著压低 completion 成本。
- `usage` 的 `calls` 可用来发现异常重试；持续 401/超时会在 `llm_calls.error` 中暴露。

---

## 8. API 示例（控制台，owner/admin）

> 完整端点/字段表见 [api.md](api.md#76-大模型设置v64)。以下只演示典型流程。

```bash
BASE=http://127.0.0.1:4380
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@mnemos.dev","password":"Demo123456"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"

# 1) 新建供应商（OpenAI 兼容）
curl -s -X POST "$BASE/api/llm/providers" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "openai-main",
  "protocol": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-…",
  "defaultModel": "gpt-4o-mini",
  "inputPrice": 0.15,
  "outputPrice": 0.6,
  "enabled": true
}' | jq .

# 2) 新建 Anthropic 供应商
curl -s -X POST "$BASE/api/llm/providers" -H "$AUTH" -H 'content-type: application/json' -d '{
  "name": "anthropic-main",
  "protocol": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-…",
  "defaultModel": "claude-sonnet-4-20250514",
  "inputPrice": 3,
  "outputPrice": 15
}' | jq .

# 3) 测试连接（最小请求）
curl -s -X POST "$BASE/api/llm/providers/llm_xxx/test" -H "$AUTH" | jq .
# {"ok":true,"latencyMs":412,"model":"gpt-4o-mini"}

# 4) 阶段分配：brief/privacy 用小模型，dream/profile 用大模型
curl -s -X PUT "$BASE/api/llm/stages/brief" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"providerId":"llm_openai","model":"gpt-4o-mini","temperature":0.2,"maxTokens":1024,"timeoutMs":20000,"enabled":true}' | jq .

curl -s -X PUT "$BASE/api/llm/stages/profile" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"providerId":"llm_anthropic","model":"claude-sonnet-4-20250514","temperature":0.3,"maxTokens":1200,"timeoutMs":30000,"enabled":true}' | jq .

# 5) 查看阶段 / 用量 / 状态
curl -s "$BASE/api/llm/stages" -H "$AUTH" | jq .
curl -s "$BASE/api/llm/usage?days=30" -H "$AUTH" | jq .
curl -s "$BASE/api/llm/status" -H "$AUTH" | jq .
# {"envFallbackConfigured":false,"providers":2,"stages":2,"encryptionConfigured":true}
```

- 响应均为包装对象：创建 `201 { provider }`、列表 `{ items }`、阶段 `{ items }` /
  `{ config }`、用量 `{ items, days }`、状态为裸对象；`DELETE` 返回 `204`。
- 供应商对象含 `apiKeyMasked`，不含 secret。供应商重名 `409 CONFLICT`；阶段非法值
  `400 VALIDATION_ERROR`；供应商不存在 `404 NOT_FOUND`。
- 请求体 camelCase；未知字段忽略（校验错误会返回 `details`）。
- 阶段 `enabled=false` 或供应商 `enabled=false` 时不产生调用、不写 `llm_calls`，也不会回退 env。

---

## 9. 控制台「模型设置」

路径：**组织设置 → 模型设置**（`/org/models`，admin+ 可见）。页面自左/上而下：

1. **说明卡**：直连 OpenAI 兼容 / Anthropic API，不依赖 DSH；展示 env fallback 是否已配置
   （`envFallbackConfigured`）与加密是否开启（`encryptionConfigured`）。
2. **供应商列表/卡片**：名称、协议、baseUrl、默认模型、输入/输出价格、启用状态、Key 掩码；
   操作：新增、编辑、启停、删除、「测试连接」。
   - 编辑弹窗：协议 select、baseUrl、默认模型、价格、API Key（**只写不读**，留空=不变）、
     「清除密钥」勾选、启用开关。
3. **阶段配置表**：五行（brief/dream/profile/privacy/extract），每行
   供应商 select、model（可覆盖 provider 默认）、temperature、maxTokens、timeoutMs、
   系统提示词（可折叠 textarea）、启用开关；逐行保存（`PUT /api/llm/stages/:stage`）。
   未绑定供应商时下拉显示「未分配 · 回退 env」；勾掉启用开关即「不使用」。
4. **用量卡片**：近 30 天按阶段的 calls / prompt tokens / completion tokens / 估算成本；
   空数据显示「暂无调用」。
5. **顶部提示**：修改后立即生效，下一次 brief/dream/profile/privacy 调用即按新配置；无需重启。

截图占位：

| 截图 | 文件 | 内容 |
| --- | --- | --- |
| 供应商列表 + 测试连接 | `docs/screenshots/v6.4-01-llm-providers.png`（待补） | 卡片列表、Key 掩码、测试结果 |
| 阶段配置表 | `docs/screenshots/v6.4-02-llm-stages.png`（待补） | 五行阶段 + 模型/温度/上限/提示词 |
| 用量 | `docs/screenshots/v6.4-03-llm-usage.png`（待补） | 按阶段成本汇总 |

> 控制台截图在页面落地后补；文档先以字段/交互说明为准。

---

## 10. 迁移、限制与验收

### 10.1 迁移

- schema v10 为**纯新增**：`llm_providers` / `llm_stage_configs` / `llm_calls` 三张表 + 两个索引，
  `meta.schema_version` 从 9 → 10；空库启动直接建，v9 库启动幂等补建，不改动既有表与数据。
- 升级后**默认仍走 v6.3 行为**：阶段表为空 → 回退 `MNEMOS_LLM_*` → 都没有则确定性。
  控制台配置阶段后才切换为「按阶段模型」。
- 回滚：v10 → v9 只需换回旧版本代码；新增表不影响旧代码（可保留或手工删除）。
- `MNEMOS_ENCRYPTION_KEY` 建议在升级前配置好；若先明文存了 Key，后配置密钥不会自动加密旧值，
  需要 PATCH 一次重新保存（或直接删除重建供应商）。

### 10.2 限制

- 不支持流式输出；不记录 prompt/响应，不提供对话回放。
- 不支持按分区覆盖模型设置：同一组织所有分区共用一套供应商/阶段配置（阶段内提示词可覆盖）。
- 供应商价格需手工维护；`estimatedCost` 是**估算**，不含缓存折扣、批处理价、汇率。
- env 回退只支持 OpenAI 兼容协议；Anthropic 必须走阶段配置。
- 调用是单次 `fetch`（有超时）；LLM 慢会拖慢对应请求/任务，但不会重试放大。

### 10.3 验收

- 两个供应商（openai + anthropic）CRUD、密钥加密/掩码、测试连接（fake server）。
- 阶段分配后 `brief` 用 A 模型、`privacy` 用 B 模型（断言请求的 model/协议/头）；无配置回退 env；
  阶段 `enabled=false` 不产生请求；失败回退确定性。
- 调用写 `llm_calls`；`usage` 汇总 tokens/成本正确（含 0 价格本地模型）。
- 控制台可配置；文档/README 更新；版本 6.4.0 / schema v10。
