# 记忆质量评测（v6.1 eval harness）

`scripts/eval-memory.ts` 是 v6.1 的离线记忆质量基线：用**内存 SQLite**（`node:sqlite`，`migrate()` 建 v7 schema）+
`createMemoryService` 构造七个场景，全部走与 HTTP 层相同的 `MemoryService` 路径，**不启动服务、不访问网络、不调用 LLM**。
输出结构化 JSON 并用退出码表达通过与否，可直接进 CI。

> **当前基线（2026-11-18，`v6-rebuild`）**：7/7 场景通过、38/38 checks、exit 0（本机约 56ms）。

## 用法

```bash
# 仓库根目录
pnpm eval

# 等价直接运行（Node >= 22.18，原生 TS type stripping）
node scripts/eval-memory.ts

# CI：保存纯 JSON 报告 + 用退出码判定
# 注意：pnpm 自身会往 stdout 打一行 "> mnemos@... eval" banner，
#       需要纯 JSON 时用 --silent（或直接跑 node）。
pnpm --silent eval > eval-report.json
echo $?    # 0=全部通过；1=有场景失败（或脚本异常）
```

- 脚本 stdout 只输出一份 JSON（便于 `jq` / 上传 artifact）；诊断信息在 JSON 的 `checks[].detail` 与 `error` 字段。
- 每个场景使用独立内存库，场景间互不污染；单个场景抛错记为 `passed:false` 并继续跑其余场景。
- 无外部依赖：本地确定性 hash-384 embedding，因此同一份代码的结果可复现。

## 场景与阈值

| 场景 id | 覆盖能力 | 关键指标 | 阈值 |
| --- | --- | --- | --- |
| `rewrite_recall` | 改写/同义召回（12 组 query↔target + 12 条干扰记忆） | `hybridRecallAt5`、`keywordRecallAt5`、`hybridMrr` | 用例 ≥10；`hybridRecallAt5 ≥ 0.8`；**严格高于** keyword |
| `temporal_update` | `factKey` 自动取代旧事实、默认检索排除旧事实、`asOf` 回看 | `temporalAccuracy` | = 1（6 项检查全过） |
| `conflict_supersede` | 显式 `supersedesId`、`history SUPERSEDE`、`includeSuperseded` | `conflictAccuracy` | = 1（5 项检查全过） |
| `isolation` | 不同人相同内容不误合并；人视角只召回本人 + 分区共享 | `isolationAccuracy` | = 1（4 项检查全过） |
| `feedback_boost` | `helpful` 反馈 → `confidence` 提升、排序不降（本场景可观测到上升） | `confidenceGain`、`rankBefore/rankAfter` | gain ≥ 0.05；`rankAfter <= rankBefore` 且本场景要求严格上升 |
| `person_merge` | merge 后 memories/facts/feedback/history 迁移、检索与画像正确 | `mergeAccuracy` | = 1（9 项检查全过） |
| `profile_facts` | `factKey` 自动沉淀、同值幂等、新值版本化（旧 fact 有 `validTo`） | `profileAccuracy` | = 1（6 项检查全过） |

阈值集中在脚本顶部 `THRESHOLDS` 常量；调阈值属于**评测口径变更**，需在 PR 说明里写清原因，
不要为了掩盖引擎回归而放宽。

## 输出结构

```jsonc
{
  "tool": "mnemos-eval",
  "version": "v6.1",
  "generatedAt": "2026-11-18T00:00:00.000Z",
  "node": "v26.11.1",
  "elapsedMs": 53.42,            // 总耗时（7 个场景合计）
  "passed": true,
  "summary": {
    "scenarios": 7,
    "passedScenarios": 7,
    "failedScenarios": 0,
    "failedScenarioIds": [],
    "checks": 38,
    "passedChecks": 38,
    "failedChecks": 0
  },
  "scenarios": [
    {
      "id": "rewrite_recall",
      "name": "改写/同义召回",
      "passed": true,
      "tookMs": 28.95,
      "metrics": { "cases": 12, "hybridRecallAt5": 1, "keywordRecallAt5": 0, "hybridMrr": 0.9167, "...": "..." },
      "thresholds": { "hybridRecallAt5": ">= 0.8", "hybridGtKeyword": true },
      "checks": [{ "name": "hybridRecallAt5", "passed": true, "detail": "hybrid recall@5=100.0%，要求 >= 80.0%" }],
      "details": [{ "query": "偏好拿铁", "target": "Alice 喜欢美式咖啡", "hybridRank": 1, "keywordRank": null }]
    }
    // ... 其余场景同构；场景抛错时额外带 error 字段
  ]
}
```

- 场景级 `passed = checks.every(passed)`；顶层 `passed = 所有场景通过`。
- 退出码：`passed ? 0 : 1`，CI 无需解析 JSON 也能判定。
- `metrics` 是给人看的汇总；`checks[].detail` 带实际值，失败时直接指出「期望 vs 实际」。
- `details` 保留每场景的命中/排序/版本快照，便于排查回归。

## CI 建议

1. **必跑**：PR 与主干都跑 `pnpm eval`，作为 `pnpm verify` 之外的记忆质量门禁。
2. **artifact**：用 `pnpm --silent eval > eval-report.json` 保存纯 JSON 并上传；失败时贴 `summary.failedScenarioIds` 与对应 `checks`。
3. **可读断言**：需要更细的告警时，用 `jq -e '.passed' eval-report.json` 或
   `jq -e '.scenarios[] | select(.id=="rewrite_recall") | .metrics.hybridRecallAt5 >= 0.8'`。
4. **耗时**：本地内存库、7 场景通常 <100ms；若 CI 上明显变慢，先看是否引入网络/LLM 依赖。
5. **回归定位**：失败场景 id 直接对应能力域：
   - `rewrite_recall` → 检索融合/embedding/候选集；
   - `temporal_update` / `conflict_supersede` → 写管线取代与 history；
   - `isolation` → 去重/检索的人级过滤；
   - `feedback_boost` → feedback 与 ranking 权重；
   - `person_merge` / `profile_facts` → 生命周期与画像。

示例（GitHub Actions 片段）：

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck:server
- run: pnpm test
- run: pnpm --silent eval > eval-report.json
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: mnemos-eval
    path: eval-report.json
```

## 排查与扩展

- 只在本地快速看结果：`node scripts/eval-memory.ts | jq '.scenarios[] | {id, passed}'`。
- 失败时先看该场景 `checks` 的 `detail`；`error` 字段代表场景抛错（如 API 契约变更导致字段缺失）。
- 新增场景：在 `scripts/eval-memory.ts` 加一个 `scenarioXxx(): ScenarioOutcome`，实现 `checks`/`metrics`/`thresholds`，
  并追加到 `SCENARIOS` 数组；阈值放进 `THRESHOLDS` 常量。
- 场景数据全部在内存库内构造，不会读写 `data-v6/`，也不会向任何真实服务发请求。
