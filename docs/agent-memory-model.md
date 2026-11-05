# Agent 原生记忆模型

> 这套基础设施的**使用者是 Agent，不是人**。控制台只是人类用来观测、审计和调参的窗口。
> 核心命题：**多个 Agent、以及同一 Agent 的不同时间段，在同一项目上工作时，共享同一份可追溯的经验。**

## 1. 三个维度

```
项目（Project）—— 共享经验库：架构决策、规范、事故复盘、环境事实
  ├── Agent（agent_id）—— 谁在记：角色、能力、模型、私有草稿
  ├── 任务（task_id）—— 何时为何而做：目标、分支、时间范围、结论
  └── 记忆（memory）—— 记了什么：内容、分类、可见性、来源、置信度
```

记忆保留既有的 `user_id / run_id / app_id` 维度，新增两个 Agent 原生维度：

- `agent_id`：写入者身份（写入后不可变，作为 provenance）。
- `task_id`：该记忆属于哪次任务会话，解决「同一 Agent 在不同时间段」的归因问题。

## 2. 可见性：共享与私有

| 可见性 | 谁可读 | 典型内容 |
| --- | --- | --- |
| `project`（默认） | 项目内所有 Agent | ADR、编码规范、事故复盘、环境事实、接口契约 |
| `agent` | 仅写入它的 Agent | 个人草稿、未验证假设、临时推理 |
| `task` | 仅同一任务会话 | 本次任务的临时上下文、中间产物 |

检索语义（有 Agent 身份时）：

```sql
WHERE project_id = :project
  AND (visibility = 'project'
       OR (visibility = 'agent' AND agent_id = :agent_id)
       OR (visibility = 'task'  AND task_id  = :task_id))
```

控制台以 `includePrivate=true` 观察全部（人类审计视角），Agent 默认看不到其他 Agent 的私有记忆。

## 3. 生命周期：上下文注入 → 工作 → 沉淀

```
Agent 注册（角色/能力/模型）
   │
   ▼
开始任务 POST /v1/tasks            task_id、goal、branch
   │
   ▼
拉取简报 POST /v1/context          ← 关键：把项目经验压成可注入的 system prompt
   │   project 背景 / conventions 规范 / decisions 决策 /
   │   experience 相似经验 / incidents 事故 / agent_notes 私有笔记 / open_tasks
   ▼
执行任务（写记忆时自动带 agent_id + task_id）
   │   过程中：踩坑、接口、临时结论 → visibility 按需
   ▼
结束任务 POST /v1/tasks/{id}/finish
   │   summary 写回任务；decisions[]、lessons[] 自动变成项目共享记忆
   ▼
下一个 Agent（或同一 Agent 下周）继续 → 简报里出现前人的结论
```

### 为什么"简报"比"搜索"重要

Agent 启动时不应只做一次相似度检索，而需要一个**结构化、有预算、可直接拼进提示词**的上下文包：

- 按作用分层（背景 / 规范 / 决策 / 经验 / 事故 / 私有笔记），避免一个大而全的 top-k。
- 有 token 预算（默认 1200），超预算按重要度与时效截断。
- 每条记忆带 `id / agent / task / date` 来源，Agent 可以引用，人类可以追溯。
- 返回 `prompt`（Markdown）+ `citations`（记忆 id）+ `tokenEstimate`，SDK 直接使用。

## 4. Python 项目开发场景（`Orion 订单服务`）

演示数据中的 4 个 Agent、6 个任务，按真实研发节奏排列：

| 时间 | 任务 | 主责 Agent | 沉淀到项目共享记忆 |
| --- | --- | --- | --- |
| 63–56 天前 | 搭建订单服务骨架 | 架构师 Agent | FastAPI + SQLAlchemy async、目录分层、uv/ruff/mypy/pytest 门禁 |
| 40–36 天前 | 库存超卖并发缺陷修复 | 开发 Agent | 根因（未加锁）、`SELECT FOR UPDATE` 修复、`deduct_stock` 幂等接口 |
| 37 天前 | 同一事故复盘 | 值班 Agent | 事故记录、库存变更统一走服务方法 |
| 37 天前 | 评审约束 | 评审 Agent | 并发扣减必须补 50 并发压测 |
| 22–18 天前 | 支付回调幂等改造 | 开发 Agent | `payment_events` 幂等表、回调顺序、死信队列 |
| 20 天前 | 评审约束 | 评审 Agent | 幂等键必须绑定业务单号 |
| 9–7 天前 | 升级 Python 3.12 | 架构师 Agent | 不再支持 3.9、uvloop 提升 QPS 12% |
| **当前** | **拆分订单查询服务** | **开发 Agent** | 读取上文全部经验；私有草稿「read replica + order_id 分片」 |
| **当前** | **接入 OpenTelemetry** | **值班 Agent** | 告警阈值、采样率方案 |

当「开发 Agent」为当前任务请求简报时，会同时拿到：

- 架构师 56 天前的分层约定（**跨时间**）
- 值班 Agent 37 天前的事故复盘（**跨 Agent**）
- 评审 Agent 20 天前的幂等键约束（**跨 Agent**）
- 架构师昨天写的「先冻结查询接口契约」（**最新约束**）
- 它自己的私有草稿（`visibility=agent`，其他 Agent 看不到）

这正是"让智能体工作有经验参考、有记录可查"。

## 5. 与常见做法的差异

| 常见做法 | 本项目 |
| --- | --- |
| 每个 Agent 独立记忆库 | 项目共享库 + Agent 私有层 + 任务层，三档可见性 |
| 只做相似度检索 | 分层简报 + token 预算 + 来源标注，可直接注入提示词 |
| 记忆无归属 | 每条记忆带 `agent_id`、`task_id`、`actor`、`history` |
| 任务结束即失忆 | `finish` 自动把决策/教训写成共享记忆，下一次任务可检索 |
| 人类直接翻日志 | 控制台按 Agent / 任务 / 可见性观测，可审计到每次写入 |

## 6. 接口速览

| 场景 | 接口 |
| --- | --- |
| Agent 注册/查询 | `POST /v1/agents`、`GET /v1/agents` |
| 开始任务 | `POST /v1/tasks` |
| 拉取上下文简报 | `POST /v1/context` |
| 写记忆（带任务/可见性） | `POST /v1/memories`（`task_id`、`visibility`） |
| 结束任务并沉淀经验 | `POST /v1/tasks/{id}/finish`（`decisions`、`lessons`） |
| 任务详情/记忆 | `GET /v1/tasks/{id}` |
| 人类观测 | 控制台「Agent」「任务」页签 |

## 7. 设计取舍

- **任务不是聊天会话**：task 有目标、分支、结论与时间范围，可跨多次运行（run_id 仍保留用于单次调用）。
- **可见性在写入时确定**：Agent 必须显式声明私有；默认共享，避免"经验孤岛"。
- **不自动跨项目共享**：项目隔离是硬边界；跨项目经验迁移需要显式导出/导入（后续 Roadmap）。
- **冲突留给检索时裁决**：不同 Agent 的结论可能矛盾，简报按重要度/时效排序并保留来源，由 Agent 判断；后续可加"记忆冲突"检测。
- **删除仍可追溯**：软删除 + history + audit，不物理抹除决策证据。
