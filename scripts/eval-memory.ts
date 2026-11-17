/**
 * Mnemos v6.1 记忆质量评测 harness（离线，不依赖真实服务）。
 *
 * 用内存 SQLite + `createMemoryService` 构造七个场景，覆盖 v6.1 P0/P1 的记忆质量能力：
 *   1) rewrite_recall    改写/同义召回：hybrid recall@5 阈值 + keyword 基线对比
 *   2) temporal_update   时效更新：factKey 取代旧事实；as_of 回看历史事实
 *   3) conflict_supersede 冲突取代：显式 supersedesId → history SUPERSEDE
 *   4) isolation         人隔离：相同内容不同人不误合并；人视角只召回本人 + 共享
 *   5) feedback_boost    反馈调权：helpful 后 confidence 提升、排序不降（本场景可观测到上升）
 *   6) person_merge      人合并：memories/facts/feedback/history 迁移 + 检索/画像正确
 *   7) profile_facts     画像 facts：factKey 自动沉淀、幂等、版本化（旧 fact validTo）
 *
 * 用法：
 *   pnpm eval
 *   node scripts/eval-memory.ts            # 与 pnpm eval 等价
 *   node scripts/eval-memory.ts > eval.json; echo $?   # CI 采集 JSON + 退出码
 *
 * 输出：stdout 一份结构化 JSON（场景 / 指标 / 阈值 / 逐项 checks / 总耗时）。
 * 退出码：全部场景通过 = 0，否则 = 1。
 */

import type { AddMemoryInput, MemoryAddResult } from '../shared/src/types.ts';
import {
  count,
  createPerson,
  setCreatedAt,
  setup,
  type Fixture,
} from '../server/src/engine/test-helpers.ts';

const EVAL_VERSION = 'v6.1';

/** 全局验收阈值（与 docs/eval.md、roadmap v6.1 第 3 节保持一致）。 */
const THRESHOLDS = {
  /** 改写召回用例数下限 */
  recallCasesMin: 10,
  /** hybrid recall@5 下限 */
  recallAt5Min: 0.8,
  /** 时序场景逐项准确率下限 */
  temporalAccuracyMin: 1,
  /** 冲突取代逐项准确率下限 */
  conflictAccuracyMin: 1,
  /** 人隔离逐项准确率下限 */
  isolationAccuracyMin: 1,
  /** 单次 helpful 的 confidence 步长 */
  feedbackConfidenceStep: 0.05,
  /** 合并逐项准确率下限 */
  mergeAccuracyMin: 1,
  /** 画像 facts 逐项准确率下限 */
  profileAccuracyMin: 1,
} as const;

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface ScenarioOutcome {
  metrics: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  checks: CheckResult[];
  details?: unknown;
}

interface ScenarioReport extends ScenarioOutcome {
  id: string;
  name: string;
  passed: boolean;
  tookMs: number;
  error?: string;
}

interface ScenarioDefinition {
  id: string;
  name: string;
  run: () => ScenarioOutcome;
}

function makeChecks(): {
  checks: CheckResult[];
  check: (name: string, passed: boolean, detail: string) => boolean;
} {
  const checks: CheckResult[] = [];
  return {
    checks,
    check(name: string, passed: boolean, detail: string): boolean {
      checks.push({ name, passed, detail });
      return passed;
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用默认分区/actor 走 MemoryService 写记忆（与 HTTP 层同一路径）。 */
function add(
  fx: Fixture,
  input: Omit<AddMemoryInput, 'partitionId' | 'actor'>,
): MemoryAddResult {
  return fx.svc.addMemoryResult({ partitionId: fx.partitionId, actor: fx.actor, ...input });
}

function rankOf(hits: readonly { id: string }[], id: string): number | null {
  const index = hits.findIndex((hit) => hit.id === id);
  return index >= 0 ? index + 1 : null;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/* ------------------------------------------------------------------ */
/* 1) 改写 / 同义召回                                                    */
/* ------------------------------------------------------------------ */

const RECALL_CASES: { content: string; query: string }[] = [
  { content: 'Alice 喜欢美式咖啡', query: '偏好拿铁' },
  { content: 'Bob 打算周五上线检索模块', query: '计划发布搜索功能' },
  { content: 'Carol 住在上海', query: '居住城市是上海' },
  { content: 'Dave 的手机号是 13800138000', query: '联系方式号码' },
  { content: 'Eve 对花生过敏', query: '忌口花生' },
  { content: '团队例会改到周三', query: '开会时间调整' },
  { content: '预算控制在二十万', query: '成本开销上限' },
  { content: '项目截止日期是下月十号', query: '期限 deadline' },
  { content: 'Grace 的昵称是小G', query: '名字称呼' },
  { content: 'Henry 负责发布流程', query: '上线部署' },
  { content: 'Ivy 的公司是字节跳动', query: '企业在哪' },
  { content: 'Frank 的职业是后端工程师', query: '工作岗位' },
];

/** 与查询无关的干扰记忆：确保 recall@5 不是靠候选集太干净拿到的。 */
const RECALL_DISTRACTORS = [
  '今天天气晴朗',
  '服务器磁盘使用率告警',
  '周报模板已经更新',
  '客户满意度调查结果',
  '接口平均耗时下降',
  '办公室绿植需要浇水',
  '季度目标已确认',
  '下载速度提升明显',
  '数据库备份完成',
  '前端页面改版评审',
  '年度团建地点投票',
  '打印机缺纸',
];

function scenarioRewriteRecall(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-recall' });
  try {
    const person = createPerson(fx, 'recall-person');
    const targetByContent = new Map<string, string>();
    for (const item of RECALL_CASES) {
      const result = add(fx, {
        personId: person.id,
        content: item.content,
        scope: 'partition',
        category: 'fact',
      });
      targetByContent.set(item.content, result.memory.id);
    }
    for (const content of RECALL_DISTRACTORS) {
      add(fx, { personId: person.id, content, scope: 'partition', category: 'context' });
    }

    const details = RECALL_CASES.map((item) => {
      const targetId = targetByContent.get(item.content) ?? '';
      const hybrid = fx.svc.searchMemories({
        partitionId: fx.partitionId,
        query: item.query,
        topK: 5,
      });
      const keyword = fx.svc.searchMemories({
        partitionId: fx.partitionId,
        query: item.query,
        topK: 5,
        mode: 'keyword',
      });
      const hybridRank = rankOf(hybrid.hits, targetId);
      const keywordRank = rankOf(keyword.hits, targetId);
      return {
        query: item.query,
        target: item.content,
        hybridRank,
        keywordRank,
        hit: hybridRank !== null,
      };
    });

    const cases = details.length;
    const hybridHits = details.filter((detail) => detail.hybridRank !== null).length;
    const keywordHits = details.filter((detail) => detail.keywordRank !== null).length;
    const hybridRecallAt5 = cases > 0 ? hybridHits / cases : 0;
    const keywordRecallAt5 = cases > 0 ? keywordHits / cases : 0;
    const hybridMrr = mean(
      details.map((detail) => (detail.hybridRank === null ? 0 : 1 / detail.hybridRank)),
    );
    const keywordMrr = mean(
      details.map((detail) => (detail.keywordRank === null ? 0 : 1 / detail.keywordRank)),
    );

    const { checks, check } = makeChecks();
    check(
      'cases>=10',
      cases >= THRESHOLDS.recallCasesMin,
      `${cases} 组 query↔target，要求 >= ${THRESHOLDS.recallCasesMin}`,
    );
    check(
      'hybridRecallAt5',
      hybridRecallAt5 >= THRESHOLDS.recallAt5Min,
      `hybrid recall@5=${percent(hybridRecallAt5)}，要求 >= ${percent(THRESHOLDS.recallAt5Min)}`,
    );
    check(
      'hybridGtKeyword',
      hybridHits > keywordHits,
      `hybrid=${hybridHits}/${cases} 应严格高于 keyword=${keywordHits}/${cases}`,
    );
    const sample = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: RECALL_CASES[0]?.query ?? '',
      topK: 5,
    });
    const sampleHit = sample.hits[0];
    check(
      'signalsExposed',
      sample.mode === 'hybrid' &&
        sample.strategy.startsWith('hybrid') &&
        sampleHit !== undefined &&
        sampleHit.signals.vector + sampleHit.signals.keyword > 0,
      `mode=${sample.mode}; strategy=${sample.strategy}; signals=vector+keyword 已返回`,
    );

    return {
      metrics: {
        cases,
        hybridHits,
        keywordHits,
        hybridRecallAt5: round(hybridRecallAt5),
        keywordRecallAt5: round(keywordRecallAt5),
        hybridMrr: round(hybridMrr),
        keywordMrr: round(keywordMrr),
        recallLift: round(hybridRecallAt5 - keywordRecallAt5),
      },
      thresholds: {
        cases: `>= ${THRESHOLDS.recallCasesMin}`,
        hybridRecallAt5: `>= ${THRESHOLDS.recallAt5Min}`,
        hybridGtKeyword: true,
      },
      checks,
      details,
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 2) 时效更新（factKey supersede + as_of）                              */
/* ------------------------------------------------------------------ */

function scenarioTemporalUpdate(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-temporal' });
  try {
    const person = createPerson(fx, 'temporal-person');
    const old = add(fx, {
      personId: person.id,
      content: 'Alice 偏好中文回答',
      scope: 'partition',
      category: 'preference',
      factKey: 'preference.language',
      validFrom: '2020-01-01T00:00:00.000Z',
    });
    const fresh = add(fx, {
      personId: person.id,
      content: 'Alice 偏好英文回答',
      scope: 'partition',
      category: 'preference',
      factKey: 'preference.language',
    });
    const oldDetail = fx.svc.getMemory(fx.partitionId, old.memory.id)?.memory ?? null;
    const oldHistory = fx.svc.memoryHistory(fx.partitionId, old.memory.id);

    const current = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: 'Alice 偏好',
      topK: 5,
    });
    const historical = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: 'Alice 偏好',
      topK: 5,
      asOf: '2021-01-01T00:00:00.000Z',
    });

    const currentIds = current.hits.map((hit) => hit.id);
    const historicalIds = historical.hits.map((hit) => hit.id);

    const { checks, check } = makeChecks();
    check('oldAdd', old.event === 'ADD', `旧事实首次写入 event=${old.event}`);
    check(
      'factKeySupersede',
      fresh.event === 'SUPERSEDE' && fresh.supersededId === old.memory.id,
      `同 factKey 新写入 event=${fresh.event}, supersededId=${fresh.supersededId ?? 'null'}`,
    );
    check(
      'oldInvalidated',
      Boolean(oldDetail?.validTo) && oldDetail?.supersededBy === fresh.memory.id,
      `旧事实 validTo=${oldDetail?.validTo ?? 'null'}, supersededBy=${oldDetail?.supersededBy ?? 'null'}`,
    );
    check(
      'defaultOnlyCurrent',
      currentIds.includes(fresh.memory.id) && !currentIds.includes(old.memory.id),
      `默认检索命中 ${currentIds.length} 条；含新事实=${currentIds.includes(fresh.memory.id)}，含旧事实=${currentIds.includes(old.memory.id)}`,
    );
    check(
      'asOfHitsOld',
      historicalIds.includes(old.memory.id) && !historicalIds.includes(fresh.memory.id),
      `as_of=2021 命中 ${historicalIds.length} 条；含旧事实=${historicalIds.includes(old.memory.id)}，含新事实=${historicalIds.includes(fresh.memory.id)}`,
    );
    check(
      'historySupersede',
      oldHistory.some((entry) => entry.event === 'SUPERSEDE'),
      `旧事实 history events=${oldHistory.map((entry) => entry.event).join(',') || '(空)'}`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        temporalAccuracy: round(passed / checks.length),
        currentHits: currentIds.length,
        asOfHits: historicalIds.length,
      },
      thresholds: { temporalAccuracy: `>= ${THRESHOLDS.temporalAccuracyMin}` },
      checks,
      details: {
        oldMemoryId: old.memory.id,
        currentMemoryId: fresh.memory.id,
        defaultSearchIds: currentIds,
        asOfSearchIds: historicalIds,
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 3) 冲突取代（显式 supersedesId）                                      */
/* ------------------------------------------------------------------ */

function scenarioConflictSupersede(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-conflict' });
  try {
    const person = createPerson(fx, 'conflict-person');
    const old = add(fx, {
      personId: person.id,
      content: '项目部署在阿里云',
      scope: 'partition',
      category: 'fact',
    });
    const fresh = add(fx, {
      personId: person.id,
      content: '项目部署迁移到腾讯云',
      scope: 'partition',
      category: 'fact',
      supersedesId: old.memory.id,
    });
    const oldDetail = fx.svc.getMemory(fx.partitionId, old.memory.id)?.memory ?? null;
    const oldHistory = fx.svc.memoryHistory(fx.partitionId, old.memory.id);
    const freshHistory = fx.svc.memoryHistory(fx.partitionId, fresh.memory.id);

    const current = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '项目部署',
      topK: 5,
    });
    const all = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '项目部署',
      topK: 5,
      includeSuperseded: true,
    });
    const currentIds = current.hits.map((hit) => hit.id);
    const allIds = all.hits.map((hit) => hit.id);

    const { checks, check } = makeChecks();
    check(
      'explicitSupersede',
      fresh.event === 'SUPERSEDE' && fresh.memory.supersedes === old.memory.id,
      `event=${fresh.event}, new.supersedes=${fresh.memory.supersedes ?? 'null'}`,
    );
    check(
      'oldInvalidated',
      Boolean(oldDetail?.validTo) && oldDetail?.supersededBy === fresh.memory.id,
      `旧事实 validTo=${oldDetail?.validTo ?? 'null'}, supersededBy=${oldDetail?.supersededBy ?? 'null'}`,
    );
    check(
      'defaultOnlyNew',
      currentIds.includes(fresh.memory.id) && !currentIds.includes(old.memory.id),
      `默认命中 ${currentIds.length} 条；含新=${currentIds.includes(fresh.memory.id)}，含旧=${currentIds.includes(old.memory.id)}`,
    );
    check(
      'historySupersede',
      oldHistory.some((entry) => entry.event === 'SUPERSEDE') &&
        freshHistory.some((entry) => entry.event === 'ADD'),
      `旧 events=${oldHistory.map((entry) => entry.event).join(',') || '(空)'}; 新 events=${freshHistory.map((entry) => entry.event).join(',') || '(空)'}`,
    );
    check(
      'includeSuperseded',
      allIds.includes(old.memory.id) && allIds.includes(fresh.memory.id),
      `includeSuperseded=true 命中 ${allIds.length} 条，新旧都可见=${allIds.includes(old.memory.id) && allIds.includes(fresh.memory.id)}`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        conflictAccuracy: round(passed / checks.length),
        defaultHits: currentIds.length,
        includeSupersededHits: allIds.length,
      },
      thresholds: { conflictAccuracy: `>= ${THRESHOLDS.conflictAccuracyMin}` },
      checks,
      details: {
        oldMemoryId: old.memory.id,
        newMemoryId: fresh.memory.id,
        defaultSearchIds: currentIds,
        includeSupersededIds: allIds,
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 4) 人隔离（同内容不误合并 + 人视角）                                  */
/* ------------------------------------------------------------------ */

function scenarioIsolation(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-isolation' });
  try {
    const alice = createPerson(fx, 'alice');
    const bob = createPerson(fx, 'bob');
    const sameContent = '团队每周五同步进度';
    const aliceSame = add(fx, { personId: alice.id, content: sameContent, scope: 'person' });
    const bobSame = add(fx, { personId: bob.id, content: sameContent, scope: 'person' });
    const alicePrivate = add(fx, {
      personId: alice.id,
      content: 'Alice 的私人偏好是早起',
      scope: 'person',
    });
    const bobPrivate = add(fx, {
      personId: bob.id,
      content: 'Bob 的私人偏好是熬夜',
      scope: 'person',
    });
    const shared = add(fx, {
      personId: alice.id,
      content: '团队共享的私人偏好约定：周五复盘',
      scope: 'partition',
    });

    const aliceView = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '私人偏好',
      personId: alice.id,
      topK: 10,
    });
    const bobView = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '私人偏好',
      personId: bob.id,
      topK: 10,
    });
    const unscoped = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '私人偏好',
      topK: 10,
    });
    const aliceIds = aliceView.hits.map((hit) => hit.id);
    const bobIds = bobView.hits.map((hit) => hit.id);
    const unscopedIds = unscoped.hits.map((hit) => hit.id);

    const { checks, check } = makeChecks();
    check(
      'sameContentNotMerged',
      aliceSame.event === 'ADD' &&
        bobSame.event === 'ADD' &&
        aliceSame.memory.id !== bobSame.memory.id &&
        fx.svc.getMemory(fx.partitionId, aliceSame.memory.id) !== null &&
        fx.svc.getMemory(fx.partitionId, bobSame.memory.id) !== null,
      `alice event=${aliceSame.event}/${aliceSame.memory.id}, bob event=${bobSame.event}/${bobSame.memory.id}，两条均存在`,
    );
    check(
      'aliceView',
      aliceIds.includes(alicePrivate.memory.id) &&
        aliceIds.includes(shared.memory.id) &&
        !aliceIds.includes(bobPrivate.memory.id),
      `alice 视角命中 ${aliceIds.length} 条：本人=${aliceIds.includes(alicePrivate.memory.id)}，共享=${aliceIds.includes(shared.memory.id)}，Bob 私密=${aliceIds.includes(bobPrivate.memory.id)}`,
    );
    check(
      'bobView',
      bobIds.includes(bobPrivate.memory.id) &&
        bobIds.includes(shared.memory.id) &&
        !bobIds.includes(alicePrivate.memory.id),
      `bob 视角命中 ${bobIds.length} 条：本人=${bobIds.includes(bobPrivate.memory.id)}，共享=${bobIds.includes(shared.memory.id)}，Alice 私密=${bobIds.includes(alicePrivate.memory.id)}`,
    );
    check(
      'unscopedSeesBoth',
      unscopedIds.includes(alicePrivate.memory.id) && unscopedIds.includes(bobPrivate.memory.id),
      `控制台/审计视角命中 ${unscopedIds.length} 条，同时含双方私密=${unscopedIds.includes(alicePrivate.memory.id) && unscopedIds.includes(bobPrivate.memory.id)}`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        isolationAccuracy: round(passed / checks.length),
        aliceHits: aliceIds.length,
        bobHits: bobIds.length,
        unscopedHits: unscopedIds.length,
      },
      thresholds: { isolationAccuracy: `>= ${THRESHOLDS.isolationAccuracyMin}` },
      checks,
      details: {
        sameContent,
        aliceMemoryIds: {
          same: aliceSame.memory.id,
          private: alicePrivate.memory.id,
        },
        bobMemoryIds: { same: bobSame.memory.id, private: bobPrivate.memory.id },
        sharedMemoryId: shared.memory.id,
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 5) 反馈调权（helpful → confidence 提升、排序不降且可观测到上升）        */
/* ------------------------------------------------------------------ */

function scenarioFeedbackBoost(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-feedback' });
  try {
    const targetPerson = createPerson(fx, 'feedback-target');
    const rivalPerson = createPerson(fx, 'feedback-rival');
    const query = '周报格式偏好';
    // 两条内容完全相同的共享记忆：查询相关性一致，仅靠 recency/importance 区分。
    const target = add(fx, {
      personId: targetPerson.id,
      content: '周报格式偏好：只要结论和风险',
      scope: 'partition',
    });
    const rival = add(fx, {
      personId: rivalPerson.id,
      content: '周报格式偏好：只要结论和风险',
      scope: 'partition',
    });
    // 目标记忆更旧（1 天），反馈前应排在 rival 之后；related 信号完全一致。
    setCreatedAt(fx.db, 'memories', target.memory.id, new Date(Date.now() - 86_400_000).toISOString());
    setCreatedAt(fx.db, 'memories', rival.memory.id, new Date().toISOString());

    const before = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query,
      topK: 10,
    });
    const rankBefore = rankOf(before.hits, target.memory.id);
    const confidenceBefore = target.memory.confidence;

    let confidenceAfter = confidenceBefore;
    let feedbackUp = 0;
    for (let index = 0; index < 3; index += 1) {
      const memory = fx.svc.feedback(
        fx.partitionId,
        target.memory.id,
        { helpful: true, query },
        fx.actor,
      );
      confidenceAfter = memory.confidence;
      feedbackUp = memory.feedbackUp ?? 0;
    }

    const after = fx.svc.searchMemories({ partitionId: fx.partitionId, query, topK: 10 });
    const rankAfter = rankOf(after.hits, target.memory.id);
    const feedbackHistory = fx.svc
      .memoryHistory(fx.partitionId, target.memory.id)
      .filter((entry) => entry.event === 'FEEDBACK').length;
    const confidenceGain = round(confidenceAfter - confidenceBefore);

    const { checks, check } = makeChecks();
    check(
      'confidenceUp',
      confidenceGain >= THRESHOLDS.feedbackConfidenceStep,
      `confidence ${confidenceBefore} → ${confidenceAfter}（+${confidenceGain}，要求 >= ${THRESHOLDS.feedbackConfidenceStep}）`,
    );
    check(
      'feedbackRecorded',
      feedbackUp === 3 && feedbackHistory === 3,
      `feedback_up=${feedbackUp}, FEEDBACK history=${feedbackHistory} 条`,
    );
    check(
      'rankNotDropped',
      rankBefore !== null && rankAfter !== null && rankAfter <= rankBefore,
      `目标记忆排序 ${rankBefore ?? '未命中'} → ${rankAfter ?? '未命中'}（要求不降）`,
    );
    check(
      'rankImproved',
      rankBefore !== null && rankAfter !== null && rankAfter < rankBefore,
      `目标记忆排序 ${rankBefore ?? '未命中'} → ${rankAfter ?? '未命中'}（要求反馈后上升，验证调权生效）`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        feedbackAccuracy: round(passed / checks.length),
        confidenceBefore,
        confidenceAfter,
        confidenceGain,
        rankBefore,
        rankAfter,
        feedbackUp,
        feedbackHistory,
      },
      thresholds: {
        confidenceGain: `>= ${THRESHOLDS.feedbackConfidenceStep}`,
        rankNotDropped: true,
        rankImproved: true,
      },
      checks,
      details: {
        query,
        targetMemoryId: target.memory.id,
        rivalMemoryId: rival.memory.id,
        beforeOrder: before.hits.map((hit) => hit.id),
        afterOrder: after.hits.map((hit) => hit.id),
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 6) 人合并（memories/facts/feedback/history 迁移 + 检索/画像）         */
/* ------------------------------------------------------------------ */

function scenarioPersonMerge(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-merge' });
  try {
    const target = createPerson(fx, 'merge-target');
    const source = createPerson(fx, 'merge-source');

    const sourcePersonal = add(fx, {
      personId: source.id,
      content: 'source 的个人偏好：简洁',
      scope: 'person',
    });
    const sourceJob = add(fx, {
      personId: source.id,
      content: 'source 的职业是 infra 工程师',
      scope: 'person',
      factKey: 'identity.job',
    });
    fx.svc.feedback(fx.partitionId, sourcePersonal.memory.id, { helpful: true, query: '偏好' }, fx.actor);
    fx.svc.upsertPersonFact(
      fx.partitionId,
      source.id,
      { key: 'identity.team', value: 'infra', confidence: 0.8 },
      fx.actor,
    );
    fx.svc.upsertPersonFact(
      fx.partitionId,
      target.id,
      { key: 'identity.team', value: 'platform', confidence: 0.9 },
      fx.actor,
    );

    const result = fx.svc.mergePersons(fx.partitionId, source.id, target.externalId, fx.actor);
    const sourceResolved = fx.svc.getPerson(fx.partitionId, source.id);
    const personalHits = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '个人偏好',
      personId: source.id,
      topK: 5,
    });
    const jobHits = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '职业',
      personId: target.id,
      topK: 5,
    });
    const activeTeamFacts = fx.svc
      .listPersonFacts(fx.partitionId, target.id)
      .filter((fact) => fact.key === 'identity.team');
    const profile = fx.svc.personProfile(fx.partitionId, target.id);
    const exported = fx.svc.exportPerson(fx.partitionId, target.id);
    const history = fx.svc.memoryHistory(fx.partitionId, sourcePersonal.memory.id);
    const historyRemainingOnSource = count(
      fx.db,
      'SELECT COUNT(*) FROM memory_history WHERE partition_id = ? AND person_id = ?',
      fx.partitionId,
      source.id,
    );
    const feedbackOnTarget = count(
      fx.db,
      'SELECT COUNT(*) FROM memory_feedback WHERE memory_id = ? AND person_id = ?',
      sourcePersonal.memory.id,
      target.id,
    );
    const listed = fx.svc.listPersons(fx.partitionId, {});
    const listedWithMerged = fx.svc.listPersons(fx.partitionId, { includeMerged: true });

    const profileKeys = profile.facts.map((fact) => fact.key).sort();
    const closedExportedFacts = exported.facts.filter((fact) => Boolean(fact.validTo)).length;

    const { checks, check } = makeChecks();
    check(
      'mergeResult',
      result.person.id === target.id &&
        result.mergedFrom.id === source.id &&
        result.movedMemories === 2 &&
        result.movedFacts === 1,
      `target=${result.person.id}, from=${result.mergedFrom.id}, movedMemories=${result.movedMemories}, movedFacts=${result.movedFacts}`,
    );
    check(
      'sourceRedirected',
      sourceResolved?.id === target.id,
      `getPerson(source) 解析到 ${sourceResolved?.id ?? 'null'}（期望 target）`,
    );
    check(
      'searchBySourceRef',
      personalHits.hits.some((hit) => hit.id === sourcePersonal.memory.id) &&
        personalHits.hits.every((hit) => hit.personId === target.id),
      `按源人 ref 检索命中 ${personalHits.hits.length} 条，personId 全部归并到 target=${personalHits.hits.every((hit) => hit.personId === target.id)}`,
    );
    check(
      'searchByTarget',
      jobHits.hits.some((hit) => hit.id === sourceJob.memory.id),
      `按 target 检索命中 ${jobHits.hits.length} 条，含迁移后的职业记忆=${jobHits.hits.some((hit) => hit.id === sourceJob.memory.id)}`,
    );
    check(
      'factDeduped',
      activeTeamFacts.length === 1,
      `合并后 identity.team 当前有效事实 ${activeTeamFacts.length} 条（期望 1 条）`,
    );
    check(
      'profileMigrated',
      profile.person.id === target.id &&
        profileKeys.includes('identity.team') &&
        profileKeys.includes('identity.job') &&
        closedExportedFacts === 1,
      `画像 keys=[${profileKeys.join(',')}]，export facts=${exported.facts.length} 条（closed=${closedExportedFacts}）`,
    );
    check(
      'historyMigrated',
      history.length > 0 && historyRemainingOnSource === 0,
      `源人记忆 history=${history.length} 条；memory_history 中 person_id=source 的残留=${historyRemainingOnSource}`,
    );
    check(
      'feedbackMigrated',
      feedbackOnTarget === 1,
      `迁移后 source 记忆的 feedback 归属 target=${feedbackOnTarget}`,
    );
    check(
      'personList',
      !listed.items.some((person) => person.id === source.id) &&
        listedWithMerged.items.some((person) => person.id === source.id),
      `默认列表排除源人=${!listed.items.some((person) => person.id === source.id)}，includeMerged 含源人=${listedWithMerged.items.some((person) => person.id === source.id)}`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        mergeAccuracy: round(passed / checks.length),
        movedMemories: result.movedMemories,
        movedFacts: result.movedFacts,
        activeTeamFacts: activeTeamFacts.length,
        profileFacts: profile.facts.length,
        exportedFacts: exported.facts.length,
      },
      thresholds: { mergeAccuracy: `>= ${THRESHOLDS.mergeAccuracyMin}` },
      checks,
      details: {
        targetPersonId: target.id,
        sourcePersonId: source.id,
        profileFactKeys: profileKeys,
        exportedFactValues: exported.facts.map((fact) => ({
          key: fact.key,
          value: fact.value,
          validTo: fact.validTo ?? null,
        })),
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 7) 画像 facts（factKey 自动沉淀 + 版本化）                            */
/* ------------------------------------------------------------------ */

function scenarioProfileFacts(): ScenarioOutcome {
  const fx = setup({ slug: 'eval-profile' });
  try {
    const carol = createPerson(fx, 'profile-carol');
    const firstMemory = add(fx, {
      personId: carol.id,
      content: 'Carol 的职业是产品经理',
      scope: 'person',
      factKey: 'identity.job',
      confidence: 0.92,
    });
    const firstProfile = fx.svc.personProfile(fx.partitionId, carol.id);
    const firstFact = firstProfile.facts[0];
    const firstExport = fx.svc.exportPerson(fx.partitionId, carol.id);
    const cachedProfile = fx.svc.personProfile(fx.partitionId, carol.id);
    const cachedExport = fx.svc.exportPerson(fx.partitionId, carol.id);

    const secondMemory = add(fx, {
      personId: carol.id,
      content: 'Carol 的职业是产品总监',
      scope: 'person',
      factKey: 'identity.job',
      confidence: 0.88,
    });
    const secondProfile = fx.svc.personProfile(fx.partitionId, carol.id);
    const secondFact = secondProfile.facts[0];
    const secondExport = fx.svc.exportPerson(fx.partitionId, carol.id);
    const closedFacts = secondExport.facts.filter((fact) => Boolean(fact.validTo));
    const activeFacts = secondExport.facts.filter((fact) => !fact.validTo);

    const { checks, check } = makeChecks();
    check(
      'autoSediment',
      firstProfile.facts.length === 1 &&
        firstFact?.key === 'identity.job' &&
        firstFact?.value === 'Carol 的职业是产品经理' &&
        firstFact?.confidence === 0.92 &&
        firstFact?.sourceMemoryId === firstMemory.memory.id,
      `facts=${firstProfile.facts.length}, key=${firstFact?.key ?? 'null'}, value=${firstFact?.value ?? 'null'}, confidence=${firstFact?.confidence ?? 'null'}, source=${firstFact?.sourceMemoryId ?? 'null'}`,
    );
    check(
      'profileCache',
      firstProfile.cached === false && cachedProfile.cached === true && cachedExport.facts.length === 1,
      `首次 cached=${firstProfile.cached}，二次 cached=${cachedProfile.cached}，二次导出 facts=${cachedExport.facts.length}（同值不刷新版本）`,
    );
    check(
      'factKeySupersedeMemory',
      secondMemory.event === 'SUPERSEDE' && secondMemory.supersededId === firstMemory.memory.id,
      `同 factKey 新记忆 event=${secondMemory.event}, supersededId=${secondMemory.supersededId ?? 'null'}`,
    );
    check(
      'factVersioned',
      secondProfile.cached === false &&
        secondProfile.facts.length === 1 &&
        secondFact?.value === 'Carol 的职业是产品总监' &&
        secondFact?.confidence === 0.88,
      `二次画像 cached=${secondProfile.cached}, 当前 facts=${secondProfile.facts.length}, value=${secondFact?.value ?? 'null'}, confidence=${secondFact?.confidence ?? 'null'}`,
    );
    check(
      'oldFactValidTo',
      secondExport.facts.length === 2 &&
        closedFacts.length === 1 &&
        closedFacts[0]?.value === 'Carol 的职业是产品经理' &&
        Boolean(closedFacts[0]?.validTo) &&
        activeFacts.length === 1,
      `facts 版本数=${secondExport.facts.length}，已关闭=${closedFacts.length}（旧值 ${closedFacts[0]?.value ?? 'null'}，validTo=${closedFacts[0]?.validTo ?? 'null'}），当前有效=${activeFacts.length}`,
    );
    check(
      'firstExportActive',
      firstExport.facts.length === 1 && !firstExport.facts[0]?.validTo,
      `首次导出 facts=${firstExport.facts.length}，无已关闭版本=${!firstExport.facts[0]?.validTo}`,
    );

    const passed = checks.filter((item) => item.passed).length;
    return {
      metrics: {
        checks: checks.length,
        passed,
        profileAccuracy: round(passed / checks.length),
        activeFacts: secondProfile.facts.length,
        factVersions: secondExport.facts.length,
        closedFacts: closedFacts.length,
      },
      thresholds: { profileAccuracy: `>= ${THRESHOLDS.profileAccuracyMin}` },
      checks,
      details: {
        firstMemoryId: firstMemory.memory.id,
        secondMemoryId: secondMemory.memory.id,
        factVersions: secondExport.facts.map((fact) => ({
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          validTo: fact.validTo ?? null,
        })),
      },
    };
  } finally {
    fx.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* 运行器                                                              */
/* ------------------------------------------------------------------ */

const SCENARIOS: ScenarioDefinition[] = [
  { id: 'rewrite_recall', name: '改写/同义召回', run: scenarioRewriteRecall },
  { id: 'temporal_update', name: '时效更新（factKey + as_of）', run: scenarioTemporalUpdate },
  { id: 'conflict_supersede', name: '冲突取代（显式 supersedes）', run: scenarioConflictSupersede },
  { id: 'isolation', name: '人隔离（不误合并 + 人视角）', run: scenarioIsolation },
  { id: 'feedback_boost', name: '反馈调权', run: scenarioFeedbackBoost },
  { id: 'person_merge', name: '人合并迁移', run: scenarioPersonMerge },
  { id: 'profile_facts', name: '画像 facts 版本化', run: scenarioProfileFacts },
];

function runScenario(definition: ScenarioDefinition): ScenarioReport {
  const started = performance.now();
  try {
    const outcome = definition.run();
    const passed = outcome.checks.every((item) => item.passed);
    return {
      id: definition.id,
      name: definition.name,
      passed,
      tookMs: round(performance.now() - started, 2),
      metrics: outcome.metrics,
      thresholds: outcome.thresholds,
      checks: outcome.checks,
      ...(outcome.details === undefined ? {} : { details: outcome.details }),
    };
  } catch (error) {
    return {
      id: definition.id,
      name: definition.name,
      passed: false,
      tookMs: round(performance.now() - started, 2),
      metrics: {},
      thresholds: {},
      checks: [],
      error: errorMessage(error),
    };
  }
}

function main(): void {
  const started = performance.now();
  const scenarios = SCENARIOS.map(runScenario);
  const elapsedMs = round(performance.now() - started, 2);
  const checks = scenarios.flatMap((scenario) => scenario.checks);
  const passedChecks = checks.filter((item) => item.passed).length;
  const failedScenarios = scenarios.filter((scenario) => !scenario.passed);
  const passed = failedScenarios.length === 0;

  const report = {
    tool: 'mnemos-eval',
    version: EVAL_VERSION,
    generatedAt: new Date().toISOString(),
    node: process.version,
    elapsedMs,
    passed,
    summary: {
      scenarios: scenarios.length,
      passedScenarios: scenarios.length - failedScenarios.length,
      failedScenarios: failedScenarios.length,
      failedScenarioIds: failedScenarios.map((scenario) => scenario.id),
      checks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
    },
    scenarios,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = passed ? 0 : 1;
}

main();
