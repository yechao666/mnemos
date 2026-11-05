/**
 * Agent 原生记忆层测试：Agent 注册表、任务会话、记忆可见性规则与任务简报。
 * 使用内存 SQLite（test-helpers.setup 内 migrate），不依赖任何运行中的服务。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainError } from './errors.ts';
import { setup, type Fixture } from './test-helpers.ts';

function isDomain(status: number) {
  return (error: unknown): boolean => error instanceof DomainError && error.status === status;
}

async function createAgent(fx: Fixture, name: string, role = 'assistant') {
  return fx.svc.createAgent(fx.projectId, { name, role }, fx.actor);
}

/* ------------------------------------------------------------------ */
/* Agent 注册表                                                        */
/* ------------------------------------------------------------------ */

test('Agent：默认值、唯一约束、部分更新与 stats 聚合', async () => {
  const fx = setup();

  const agent = await createAgent(fx, '架构师 Agent');
  assert.equal(agent.projectId, fx.projectId);
  assert.equal(agent.name, '架构师 Agent');
  assert.equal(agent.role, 'assistant');
  assert.equal(agent.model, 'deepseek-chat');
  assert.equal(agent.description, '');
  assert.deepEqual(agent.capabilities, []);
  assert.equal(agent.status, 'active');
  assert.ok(agent.createdAt);
  assert.ok(agent.lastActiveAt);
  assert.equal(agent.stats.memories, 0);
  assert.equal(agent.stats.privateMemories, 0);
  assert.equal(agent.stats.tasks, 0);
  assert.equal(agent.stats.lastTaskAt, undefined);

  const listed = await fx.svc.agents(fx.projectId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, agent.id);

  const loaded = await fx.svc.agent(fx.projectId, agent.id);
  assert.equal(loaded?.name, '架构师 Agent');
  assert.equal(await fx.svc.agent(fx.projectId, 'agent_missing'), null);

  // (project_id, name) 唯一
  await assert.rejects(() => createAgent(fx, '架构师 Agent'), isDomain(409));

  const updated = await fx.svc.updateAgent(
    fx.projectId,
    agent.id,
    { role: 'architect', model: 'deepseek-reasoner', capabilities: ['adr', 'review', 'adr'], status: 'idle' },
    fx.actor,
  );
  assert.equal(updated.role, 'architect');
  assert.equal(updated.model, 'deepseek-reasoner');
  assert.deepEqual(updated.capabilities, ['adr', 'review']);
  assert.equal(updated.status, 'idle');
  assert.equal(updated.name, '架构师 Agent');

  // stats：active 记忆数、私有记忆数、参与任务数
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '架构师 Agent 负责服务边界评审与接口契约',
    infer: false,
    agentId: agent.id,
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '架构师 Agent 的私有笔记：评审时先看依赖方向',
    infer: false,
    agentId: agent.id,
    visibility: 'agent',
  });
  const task = await fx.svc.createTask(fx.projectId, { title: '梳理服务边界', ownerAgentId: agent.id }, fx.actor);

  const refreshed = await fx.svc.agent(fx.projectId, agent.id);
  assert.equal(refreshed?.stats.memories, 2);
  assert.equal(refreshed?.stats.privateMemories, 1);
  assert.equal(refreshed?.stats.tasks, 1);
  assert.ok(refreshed?.stats.lastTaskAt);
  assert.equal(refreshed?.stats.lastTaskAt, task.startedAt);
  assert.ok(refreshed?.lastActiveAt);

  // 任务结束沉淀的记忆也会让「该 agent 写入过记忆的任务」计数
  await fx.svc.finishTask(fx.projectId, task.id, { decisions: ['边界按领域拆分'], agentId: agent.id }, fx.actor);
  const afterFinish = await fx.svc.agent(fx.projectId, agent.id);
  assert.equal(afterFinish?.stats.memories, 3);
});

/* ------------------------------------------------------------------ */
/* 任务会话                                                            */
/* ------------------------------------------------------------------ */

test('Task：创建、结束自动沉淀记忆（visibility=project、taskId 关联）且重复结束 409', async () => {
  const fx = setup();
  const agent = await createAgent(fx, '开发 Agent', 'developer');
  const task = await fx.svc.createTask(
    fx.projectId,
    { title: '支付回调幂等改造', goal: '消除支付回调重复处理导致的重复发货', ownerAgentId: agent.id, branch: 'fix/idempotency' },
    fx.actor,
  );

  assert.equal(task.status, 'active');
  assert.ok(task.startedAt);
  assert.equal(task.ownerAgentId, agent.id);
  assert.equal(task.ownerAgentName, '开发 Agent');
  assert.equal(task.branch, 'fix/idempotency');
  assert.equal(task.memoryCount, 0);
  assert.equal(task.agentCount, 0);

  const finished = await fx.svc.finishTask(
    fx.projectId,
    task.id,
    {
      summary: '落地 payment_events 幂等表与唯一键',
      decisions: ['采用 payment_events 幂等表保证回调只处理一次'],
      lessons: ['重复回调必须依赖唯一键而不是内存状态'],
      notes: ['压测 50 并发验证无重复发货'],
      agentId: agent.id,
    },
    fx.actor,
  );

  assert.equal(finished.task.status, 'done');
  assert.ok(finished.task.endedAt);
  assert.equal(finished.task.summary, '落地 payment_events 幂等表与唯一键');
  assert.equal(finished.memories.length, 3);
  assert.equal(finished.task.memoryCount, 3);
  assert.equal(finished.task.agentCount, 1);

  const decision = finished.memories.find((memory) => memory.content.includes('payment_events'));
  assert.ok(decision);
  assert.equal(decision.category, 'fact');
  assert.equal(decision.importance, 0.82);
  assert.equal(decision.visibility, 'project');
  assert.equal(decision.taskId, task.id);
  assert.equal(decision.agentId, agent.id);
  assert.equal(decision.source, 'agent');
  assert.equal(decision.status, 'active');

  const lesson = finished.memories.find((memory) => memory.content.includes('唯一键'));
  assert.ok(lesson);
  assert.equal(lesson.category, 'constraint');
  assert.equal(lesson.importance, 0.78);

  const note = finished.memories.find((memory) => memory.content.includes('50 并发'));
  assert.ok(note);
  assert.equal(note.category, 'event');
  assert.equal(note.importance, 0.6);

  // 列表：状态过滤、agentId（owner 或写过记忆）、时间倒序
  const doneTasks = await fx.svc.tasks(fx.projectId, { status: 'done' });
  assert.equal(doneTasks.length, 1);
  assert.equal(doneTasks[0]?.id, task.id);
  assert.equal((await fx.svc.tasks(fx.projectId, { status: 'active' })).length, 0);
  assert.equal((await fx.svc.tasks(fx.projectId, { agentId: agent.id })).length, 1);
  assert.equal((await fx.svc.tasks(fx.projectId, { agentId: 'agent_other' })).length, 0);
  assert.equal((await fx.svc.task(fx.projectId, task.id))?.memoryCount, 3);
  assert.equal(await fx.svc.task(fx.projectId, 'task_missing'), null);

  // 任务记忆可通过 taskId 检索到
  const searched = await fx.svc.search({ projectId: fx.projectId, query: '幂等 回调 决策', taskId: task.id });
  assert.ok(searched.results.length >= 1);
  assert.ok(searched.results.every((memory) => memory.taskId === task.id));

  // 重复结束 → 409
  await assert.rejects(() => fx.svc.finishTask(fx.projectId, task.id, { summary: 'again' }, fx.actor), isDomain(409));
  // 不存在的任务 → 404
  await assert.rejects(() => fx.svc.finishTask(fx.projectId, 'task_missing', {}, fx.actor), isDomain(404));
});

test('Task：updateTask 在 status→done/abandoned 时自动维护 endedAt', async () => {
  const fx = setup();
  const task = await fx.svc.createTask(fx.projectId, { title: '升级 Python 3.12' }, fx.actor);
  assert.equal(task.endedAt, undefined);

  const done = await fx.svc.updateTask(fx.projectId, task.id, { status: 'done', summary: '升级完成' }, fx.actor);
  assert.equal(done.status, 'done');
  assert.ok(done.endedAt);
  assert.equal(done.summary, '升级完成');

  const reopened = await fx.svc.updateTask(fx.projectId, task.id, { status: 'active' }, fx.actor);
  assert.equal(reopened.endedAt, undefined);
  assert.equal(reopened.summary, '升级完成');

  const abandoned = await fx.svc.updateTask(fx.projectId, task.id, { title: '升级 Python 3.13', status: 'abandoned' }, fx.actor);
  assert.equal(abandoned.title, '升级 Python 3.13');
  assert.equal(abandoned.status, 'abandoned');
  assert.ok(abandoned.endedAt);
});

/* ------------------------------------------------------------------ */
/* 可见性                                                              */
/* ------------------------------------------------------------------ */

test('可见性：Agent 私有仅本人可见、includePrivate 审计可见、task 记忆仅本任务可见', async () => {
  const fx = setup();
  const alpha = await createAgent(fx, 'Alpha Agent');
  const beta = await createAgent(fx, 'Beta Agent');

  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: 'Alpha 的私有调试技巧：开启 SQL 慢查询日志',
    infer: false,
    agentId: alpha.id,
    visibility: 'agent',
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '项目共享架构原则：所有写操作必须幂等',
    infer: false,
    agentId: alpha.id,
  });
  const task1 = await fx.svc.createTask(fx.projectId, { title: '排查订单服务慢查询', ownerAgentId: alpha.id }, fx.actor);
  const task2 = await fx.svc.createTask(fx.projectId, { title: '支付幂等改造', ownerAgentId: beta.id }, fx.actor);
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '任务内临时上下文：订单服务慢查询由缺少索引导致',
    infer: false,
    agentId: alpha.id,
    taskId: task1.id,
    visibility: 'task',
  });

  // 默认写入 visibility=project
  const shared = await fx.svc.search({ projectId: fx.projectId, query: '幂等 架构原则' });
  const sharedHit = shared.results.find((memory) => memory.content.includes('幂等'));
  assert.ok(sharedHit);
  assert.equal(sharedHit.visibility, 'project');
  assert.ok(shared.results.every((memory) => memory.visibility === 'project'));

  // 本人可见自己的私有记忆
  const own = await fx.svc.search({ projectId: fx.projectId, query: 'SQL 慢查询日志', agentId: alpha.id });
  assert.ok(own.results.some((memory) => memory.visibility === 'agent' && memory.content.includes('私有')));

  // 其他 Agent 检索不到
  const other = await fx.svc.search({ projectId: fx.projectId, query: 'SQL 慢查询日志', agentId: beta.id });
  assert.ok(!other.results.some((memory) => memory.content.includes('私有')));

  // 控制台 / 审计视角
  const audit = await fx.svc.search({ projectId: fx.projectId, query: 'SQL 慢查询 私有', includePrivate: true });
  assert.ok(audit.results.some((memory) => memory.visibility === 'agent'));

  // task 记忆：仅本任务（taskId 上下文）可见
  const inTask = await fx.svc.search({ projectId: fx.projectId, query: '订单服务慢查询 索引', taskId: task1.id });
  assert.ok(inTask.results.some((memory) => memory.taskId === task1.id));
  assert.ok(inTask.results.every((memory) => memory.taskId === task1.id));
  const otherTask = await fx.svc.search({ projectId: fx.projectId, query: '订单服务慢查询 索引', taskId: task2.id });
  assert.equal(otherTask.results.length, 0);
  const noTask = await fx.svc.search({ projectId: fx.projectId, query: '临时上下文 订单服务慢查询' });
  assert.ok(!noTask.results.some((memory) => memory.taskId === task1.id));

  // 列表：visibility 过滤 / includePrivate
  const privateList = await fx.svc.list({ projectId: fx.projectId, agentId: alpha.id, visibility: 'agent' });
  assert.equal(privateList.total, 1);
  assert.equal(privateList.items[0]?.visibility, 'agent');
  const taskList = await fx.svc.list({ projectId: fx.projectId, taskId: task1.id });
  assert.equal(taskList.total, 1);
  assert.equal(taskList.items[0]?.visibility, 'task');
  const auditList = await fx.svc.list({ projectId: fx.projectId, includePrivate: true });
  assert.equal(auditList.total, 3);
  const projectList = await fx.svc.list({ projectId: fx.projectId });
  assert.equal(projectList.total, 1);
  assert.equal(projectList.items[0]?.visibility, 'project');

  // visibility=task 必须带 taskId → 422
  await assert.rejects(
    () =>
      fx.svc.add({
        projectId: fx.projectId,
        actor: fx.actor,
        text: '缺少任务归属的临时记忆',
        infer: false,
        visibility: 'task',
      }),
    isDomain(422),
  );

  // metadata.taskId 兜底推断任务归属
  const inferred = await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '通过 metadata 推断任务归属的记忆',
    infer: false,
    metadata: { taskId: task1.id },
  });
  assert.equal(inferred.results[0]?.taskId, task1.id);
});

/* ------------------------------------------------------------------ */
/* 任务简报                                                            */
/* ------------------------------------------------------------------ */

test('briefing：段落齐全、prompt 含任务与记忆 id、token 预算截断', async () => {
  const fx = setup();
  const agent = await fx.svc.createAgent(
    fx.projectId,
    { name: '开发 Agent', role: 'developer', model: 'deepseek-chat', capabilities: ['python', 'tests'] },
    fx.actor,
  );
  const task = await fx.svc.createTask(
    fx.projectId,
    { title: '支付回调幂等改造', goal: '消除支付回调重复处理导致的重复发货', ownerAgentId: agent.id },
    fx.actor,
  );

  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '项目背景与目标：订单服务必须保证支付回调只处理一次',
    infer: false,
    agentId: agent.id,
    metadata: { category: 'identity', importance: 0.9 },
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '编码规范 约定：所有接口必须写测试，命名使用 snake_case',
    infer: false,
    metadata: { category: 'constraint', importance: 0.8 },
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '架构决策 方案 选型：支付回调使用 payment_events 幂等表',
    infer: false,
    metadata: { category: 'fact', importance: 0.85 },
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '线上故障 事故：支付回调重复触发导致重复发货并回滚',
    infer: false,
    agentId: agent.id,
    metadata: { category: 'event', importance: 0.8 },
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '支付回调幂等改造经验：先落幂等表再发货，失败重试进入死信队列',
    infer: false,
    agentId: agent.id,
  });
  await fx.svc.add({
    projectId: fx.projectId,
    actor: fx.actor,
    text: '开发 Agent 私有笔记：本地用 SQLite 复现回调重复',
    infer: false,
    agentId: agent.id,
    visibility: 'agent',
  });

  const briefing = await fx.svc.briefing({ projectId: fx.projectId, agentId: agent.id, taskId: task.id });

  assert.equal(briefing.project.id, fx.projectId);
  assert.equal(briefing.agent?.id, agent.id);
  assert.equal(briefing.task?.id, task.id);
  assert.ok(briefing.builtAt);
  assert.ok(briefing.tookMs >= 0);
  assert.ok(briefing.tokenEstimate > 0);

  // 段落齐全且顺序稳定
  assert.deepEqual(
    briefing.sections.map((section) => section.key),
    ['project', 'conventions', 'decisions', 'experience', 'incidents', 'agent_notes', 'open_tasks'],
  );
  assert.ok(briefing.sections.every((section) => section.title.length > 0 && section.description.length > 0));

  // prompt：任务信息 + 记忆 id + 来源标注
  assert.ok(briefing.prompt.includes(task.id));
  assert.ok(briefing.prompt.includes(task.title));
  assert.ok(briefing.prompt.includes('owner: 开发 Agent'));
  assert.ok(briefing.prompt.includes('from: '));
  assert.ok(briefing.citations.length > 0);
  assert.ok(briefing.citations.length <= 20);
  assert.equal(new Set(briefing.citations).size, briefing.citations.length);
  for (const id of briefing.citations) assert.ok(briefing.prompt.includes(`[${id}]`));

  // agent 私有笔记进入 agent_notes 段落
  const notes = briefing.sections.find((section) => section.key === 'agent_notes');
  assert.ok(notes);
  assert.ok(notes.hits.some((hit) => hit.content.includes('私有笔记')));

  // open_tasks 非记忆段落：hits 为空但任务清单在 prompt 中
  const openTasks = briefing.sections.find((section) => section.key === 'open_tasks');
  assert.ok(openTasks);
  assert.deepEqual(openTasks.hits, []);
  assert.ok(briefing.prompt.includes('## 进行中任务'));

  // 预算截断：更小的预算 → 更少命中且 token 估算不超过预算
  const tight = await fx.svc.briefing({ projectId: fx.projectId, agentId: agent.id, taskId: task.id, budgetTokens: 120 });
  assert.ok(tight.tokenEstimate <= 120);
  assert.equal(tight.sections.length, 7);
  assert.ok(tight.citations.length <= briefing.citations.length);
  assert.ok(tight.prompt.length <= briefing.prompt.length);

  // query 覆盖 experience 检索词
  const custom = await fx.svc.briefing({
    projectId: fx.projectId,
    agentId: agent.id,
    taskId: task.id,
    query: '死信队列',
  });
  assert.ok(custom.sections.find((section) => section.key === 'experience')?.hits.some((hit) => hit.content.includes('死信队列')));
});
