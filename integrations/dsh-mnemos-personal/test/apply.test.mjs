/**
 * 插件入口（apply）测试：用假上下文验证装配行为，不需要真的启动 dsh。
 *
 * 重点回归 dsh 0.2 的平台陷阱（参考旧插件 dsh-mnemos / dsh-mem0 的踩坑记录）：
 * 1. `.volatile()` 字段**不是裸值**，而是 `{ get() }` 引用 —— 直接把 Config({}) 的产物传给
 *    apply，能真实复现装配时的形状；`resolveConfig` 必须解包它。
 * 2. `settings.configure` 必须显式传插件自己的 fiber，并且只在自家命名空间的事件上 re-sync。
 * 3. 系统提示段是动态求值的：按当前会话工作区算分区 slug（fixed 模式用配置值）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, DEFAULT_CONFIG, MNEMOS_SETTINGS_NAMESPACE, resolveConfig } from '../lib/config.js'
import { apply, buildSystemPromptText, inject, name } from '../lib/index.js'
import { workspaceSlug } from '../lib/workspace.js'
import { createMnemosFake } from './helpers.mjs'

/** 构造一个最小的假宿主上下文。 */
function createContext({ settings, workingDirectory } = {}) {
  const state = {
    tools: new Map(),
    sections: new Map(),
    configureCalls: [],
    listeners: new Map(),
  }
  const services = { settings, workingDirectory }
  const scoped = {
    get: (serviceName) => services[serviceName],
    on: (event, listener) => {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {
        state.listeners.set(
          event,
          (state.listeners.get(event) ?? []).filter((item) => item !== listener),
        )
      }
    },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(options) {
        state.sections.set(options.name, options)
        return () => state.sections.delete(options.name)
      },
    },
    fiber: { id: 'fake-fiber' },
    get: (serviceName) => services[serviceName],
    on: (event, listener) => scoped.on(event, listener),
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
    inject(names, callback) {
      assert.deepEqual([...names], ['settings'], '插件只应注入 settings')
      callback(scoped)
      return () => {}
    },
  }
  const fire = (namespace) => {
    for (const listener of state.listeners.get('settings/document-updated') ?? []) listener(namespace)
  }
  return { ctx, state, fire }
}

/** 构造可变的 volatile 配置：字段形状与运行时一致（每个字段都是 { get() }）。 */
function volatileConfig(overrides = {}) {
  const values = { ...DEFAULT_CONFIG, orgApiKey: 'mnemos_live_apply_test', ...overrides }
  const raw = {}
  for (const key of Object.keys(values)) raw[key] = { get: () => values[key] }
  return { values, raw }
}

/** 取系统提示段并求值。 */
function renderSection(state, agent) {
  const section = state.sections.get('plugin:dsh-mnemos-personal')
  assert.ok(section, '缺少系统提示段')
  assert.equal(typeof section.text, 'function', '提示段应动态求值（按工作区算 slug）')
  return section.text({ agent })
}

describe('插件元信息与配置 schema', () => {
  it('名称、注入服务与设置命名空间正确', () => {
    assert.equal(name, 'dsh-mnemos-personal')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
    assert.equal(MNEMOS_SETTINGS_NAMESPACE, 'dsh-mnemos-personal')
  })

  it('Config 的 8 个字段全是 volatile，默认值与文档一致', () => {
    const resolved = Config({})
    const expected = {
      baseUrl: 'http://127.0.0.1:4380',
      orgApiKey: '',
      personId: 'dsh-agent',
      personType: 'agent',
      partitionMode: 'workspace',
      fixedPartition: '',
      readOnly: false,
      systemPrompt: true,
    }
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(Config.dict).sort())
    for (const [key, value] of Object.entries(expected)) {
      const field = resolved[key]
      assert.equal(typeof field?.get, 'function', `${key} 必须是 volatile 字段（否则设置页看不到它）`)
      assert.deepEqual(field.get(), value, `${key} 的默认值不对`)
    }
  })

  it('Config 拒绝非法 partitionMode / personType', () => {
    assert.throws(() => Config({ partitionMode: 'world' }))
    assert.throws(() => Config({ personType: 'robot' }))
  })

  it('resolveConfig 解包 volatile 引用，并对缺省值 / 非法枚举回落默认', () => {
    const { raw } = volatileConfig({ baseUrl: 'http://10.0.0.5:9000', partitionMode: 'fixed', fixedPartition: 'mnemos-prod', readOnly: true })
    const resolved = resolveConfig(raw)
    assert.equal(resolved.baseUrl, 'http://10.0.0.5:9000')
    assert.equal(resolved.partitionMode, 'fixed')
    assert.equal(resolved.fixedPartition, 'mnemos-prod')
    assert.equal(resolved.readOnly, true)
    assert.equal(resolved.orgApiKey, 'mnemos_live_apply_test')

    const defaults = resolveConfig(undefined)
    assert.equal(defaults.baseUrl, 'http://127.0.0.1:4380')
    assert.equal(defaults.personId, 'dsh-agent')
    assert.equal(defaults.personType, 'agent')
    assert.equal(defaults.partitionMode, 'workspace')
    assert.equal(defaults.systemPrompt, true)
    assert.equal(resolveConfig({ partitionMode: 'world', personType: 'robot' }).partitionMode, 'workspace')
    assert.equal(resolveConfig({ personId: 'alice' }).personId, 'alice')
  })
})

describe('系统提示文案', () => {
  it('workspace 模式注入「本工作区已绑定分区 <slug>，记忆按人组织；默认人 <personId>」', () => {
    const config = resolveConfig(undefined)
    const text = buildSystemPromptText(config, '/work/demo')
    const slug = workspaceSlug('/work/demo')
    assert.match(text, new RegExp(`本工作区已绑定分区 ${slug}，记忆按人组织；默认人 dsh-agent`))
    assert.match(text, /mnemos_context/)
    assert.match(text, /mnemos_add/)
    assert.match(text, /orgApiKey/)
  })

  it('fixed 模式用 fixedPartition 作为绑定分区', () => {
    const config = resolveConfig({ partitionMode: 'fixed', fixedPartition: 'mnemos-prod', personId: 'agent-a' })
    const text = buildSystemPromptText(config, '/work/demo')
    assert.match(text, /本工作区已绑定分区 mnemos-prod，记忆按人组织；默认人 agent-a/)
    assert.doesNotMatch(text, /ws-demo/)
  })

  it('没有工作区路径时明确说出而不是崩掉', () => {
    const text = buildSystemPromptText(resolveConfig(undefined), undefined)
    assert.match(text, /当前会话没有工作区路径/)
  })
})

describe('apply 装配', () => {
  it('用真实 volatile 形状注册 8 个工具与动态提示段，并配置设置页', () => {
    const configureCalls = []
    const settings = {
      configure(policy, owner) {
        configureCalls.push({ policy, owner })
        return () => {}
      },
    }
    const { ctx, state } = createContext({ settings })

    // 直接传 Config({}) 的产物：这正是 dsh 运行时交给 apply 的形状（字段是 Volatile 引用）。
    apply(ctx, Config({}))

    assert.equal(state.tools.size, 8)
    for (const toolName of [
      'mnemos_workspace',
      'mnemos_add',
      'mnemos_search',
      'mnemos_get',
      'mnemos_brief',
      'mnemos_context',
      'mnemos_person',
      'mnemos_status',
    ]) {
      assert.ok(state.tools.has(toolName), `缺少工具 ${toolName}`)
    }

    // 提示段：按当前会话工作区算 slug
    const text = renderSection(state, { session: { header: { cwd: '/work/demo' } } })
    assert.match(text, /本工作区已绑定分区 ws-demo-[0-9a-f]{8}/)
    assert.match(text, /默认人 dsh-agent/)
    assert.equal(text, buildSystemPromptText(resolveConfig(Config({})), '/work/demo'))

    // 自动表单：auto=true 且 owner 必须是插件自己的 fiber
    assert.equal(configureCalls.length, 1)
    assert.deepEqual(configureCalls[0].policy, { auto: true })
    assert.equal(configureCalls[0].owner, ctx.fiber)
  })

  it('没有会话头 cwd 时从 workingDirectory 服务取当前目录', () => {
    const workingDirectory = { get: () => '/work/from-service' }
    const { ctx, state } = createContext({ workingDirectory })
    apply(ctx, Config({}))
    const text = renderSection(state, { session: {} })
    assert.match(text, new RegExp(workspaceSlug('/work/from-service')))
  })

  it('systemPrompt=false 时不注册提示段，工具照常注册', () => {
    const { ctx, state } = createContext()
    apply(ctx, Config({ systemPrompt: false }))
    assert.equal(state.tools.size, 8)
    assert.equal(state.sections.size, 0)
  })

  it('fixed 模式 + volatile 配置的提示段按 fixedPartition 求值', () => {
    const { ctx, state } = createContext()
    const { raw } = volatileConfig({ partitionMode: 'fixed', fixedPartition: 'mnemos-prod' })
    apply(ctx, raw)
    const text = renderSection(state, { session: { header: { cwd: '/work/demo' } } })
    assert.match(text, /本工作区已绑定分区 mnemos-prod/)
  })

  it('设置变更后只在自家命名空间 re-sync（切换 systemPrompt 生效）', () => {
    const settings = { configure: () => () => {} }
    const { ctx, state, fire } = createContext({ settings })
    const { values, raw } = volatileConfig()
    apply(ctx, raw)
    assert.equal(state.tools.size, 8)
    assert.equal(state.sections.size, 1)

    // 别的插件保存配置：不受影响
    fire('dsh-mnemos')
    assert.equal(state.tools.size, 8)
    assert.equal(state.sections.size, 1)

    // 自己的命名空间：关掉提示段，工具保持
    values.systemPrompt = false
    fire(MNEMOS_SETTINGS_NAMESPACE)
    assert.equal(state.tools.size, 8)
    assert.equal(state.sections.size, 0)

    // 再打开：提示段回来
    values.systemPrompt = true
    fire(MNEMOS_SETTINGS_NAMESPACE)
    assert.equal(state.sections.size, 1)
  })

  it('装配后的工具能真实走通假后端（apply → workspace → add → search）', async () => {
    const fake = await createMnemosFake()
    try {
      const { ctx, state } = createContext()
      apply(ctx, Config({ baseUrl: fake.url, orgApiKey: 'test_org_key' }))
      const exec = { agent: { session: { id: 'sess_e2e', header: { cwd: '/work/e2e' } } } }

      const workspace = await state.tools.get('mnemos_workspace').execute({}, exec)
      assert.equal(workspace.ok, true, workspace.error)
      assert.equal(workspace.partition.slug, workspaceSlug('/work/e2e'))

      const add = await state.tools.get('mnemos_add').execute({ text: 'e2e 记忆', scope: 'person' }, exec)
      assert.equal(add.ok, true, add.error)

      const search = await state.tools.get('mnemos_search').execute({ query: 'e2e' }, exec)
      assert.equal(search.ok, true, search.error)
      assert.equal(search.count, 1)
      assert.match(search.results[0].content, /e2e 记忆/)
    } finally {
      await fake.close()
    }
  })

  it('没有 settings 服务（headless / CLI 挂载）时不抛异常，工具照常注册', () => {
    const { ctx, state } = createContext()
    assert.doesNotThrow(() => apply(ctx, Config({})))
    assert.equal(state.tools.size, 8)
    assert.equal(state.sections.size, 1)
  })

  it('settings 服务缺少 configure 方法时也能装配', () => {
    const { ctx, state } = createContext({ settings: {} })
    assert.doesNotThrow(() => apply(ctx, Config({})))
    assert.equal(state.tools.size, 8)
  })

})
