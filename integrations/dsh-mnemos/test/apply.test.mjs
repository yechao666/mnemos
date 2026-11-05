/**
 * 插件入口（apply）测试：用假上下文验证装配行为，不需要真的启动 dsh。
 *
 * 重点回归 dsh 0.2 的两个平台陷阱（参考 dsh-mem0 的 AGENTS.md）：
 * 1. `.volatile()` 字段**不是裸值**，而是 `{ get() }` 引用 —— 直接把 Config({}) 的产物传给
 *    apply，能真实复现装配时的形状；`resolveConfig` 必须解包它。
 * 2. `settings.configure` 必须显式传插件自己的 fiber，并且只在自家命名空间的事件上 re-sync。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, MNEMOS_SETTINGS_NAMESPACE, resolveConfig } from '../lib/config.js'
import { apply, inject, MNEMOS_GUIDANCE, name } from '../lib/index.js'

/** 构造一个最小的假宿主上下文。 */
function createContext({ settings, autoInject = true } = {}) {
  const state = {
    tools: new Set(),
    sections: new Map(),
    configureCalls: [],
    listeners: new Map(),
  }
  const scoped = {
    get: (serviceName) => (serviceName === 'settings' ? settings : undefined),
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
        state.tools.add(definition.name)
        return () => state.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(options) {
        state.sections.set(options.name, options.text)
        return () => state.sections.delete(options.name)
      },
    },
    fiber: { id: 'fake-fiber' },
    get: () => undefined,
    on: (event, listener) => scoped.on(event, listener),
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
    inject(names, callback) {
      assert.deepEqual([...names], ['settings'], '插件只应注入 settings')
      if (autoInject) callback(scoped)
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
  const values = {
    baseUrl: 'http://127.0.0.1:4380',
    apiKey: 'mnemos_live_apply_test',
    defaultAgentId: 'dsh-agent',
    defaultUserId: '',
    defaultTaskId: '',
    defaultTopK: 8,
    readOnly: false,
    announceToAgent: true,
    enabled: true,
    timeoutMs: 15000,
    ...overrides,
  }
  const raw = {}
  for (const key of Object.keys(values)) raw[key] = { get: () => values[key] }
  return { values, raw }
}

describe('插件元信息与配置 schema', () => {
  it('名称、注入服务与设置命名空间正确', () => {
    assert.equal(name, 'dsh-mnemos')
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
    assert.equal(MNEMOS_SETTINGS_NAMESPACE, 'dsh-mnemos')
  })

  it('Config 的 10 个字段全是 volatile，默认值与文档一致', () => {
    const resolved = Config({})
    const expected = {
      baseUrl: 'http://127.0.0.1:4380',
      apiKey: '',
      defaultAgentId: 'dsh-agent',
      defaultUserId: '',
      defaultTaskId: '',
      defaultTopK: 8,
      readOnly: false,
      announceToAgent: true,
      enabled: true,
      timeoutMs: 15000,
    }
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(Config.dict).sort())
    for (const [key, value] of Object.entries(expected)) {
      const field = resolved[key]
      assert.equal(typeof field?.get, 'function', `${key} 必须是 volatile 字段（否则设置页看不到它）`)
      assert.deepEqual(field.get(), value, `${key} 的默认值不对`)
    }
  })

  it('resolveConfig 解包 volatile 引用，并对缺省值回落默认', () => {
    const { raw } = volatileConfig({ baseUrl: 'http://10.0.0.5:9000', defaultTopK: 12, readOnly: true })
    const resolved = resolveConfig(raw)
    assert.equal(resolved.baseUrl, 'http://10.0.0.5:9000')
    assert.equal(resolved.defaultTopK, 12)
    assert.equal(resolved.readOnly, true)
    assert.equal(resolved.apiKey, 'mnemos_live_apply_test')

    // 空配置与裸值都要能跑（手搭上下文 / 老宿主）
    const defaults = resolveConfig(undefined)
    assert.equal(defaults.baseUrl, 'http://127.0.0.1:4380')
    assert.equal(defaults.defaultAgentId, 'dsh-agent')
    assert.equal(defaults.enabled, true)
    assert.equal(resolveConfig({ enabled: false }).enabled, false)
    assert.equal(resolveConfig({ defaultTopK: 3 }).defaultTopK, 3)
  })
})

describe('apply 装配', () => {
  it('用真实 volatile 形状注册 10 个工具与提示段，并配置设置页', () => {
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

    assert.equal(state.tools.size, 10)
    for (const toolName of [
      'mnemos_search',
      'mnemos_add',
      'mnemos_context',
      'mnemos_task',
      'mnemos_get',
      'mnemos_update',
      'mnemos_delete',
      'mnemos_history',
      'mnemos_agent',
      'mnemos_status',
    ]) {
      assert.ok(state.tools.has(toolName), `缺少工具 ${toolName}`)
    }

    assert.equal(state.sections.size, 1)
    const guidance = state.sections.get('plugin:dsh-mnemos')
    assert.equal(guidance, MNEMOS_GUIDANCE)
    assert.match(guidance, /mnemos_context/)
    assert.match(guidance, /mnemos_task/)
    assert.match(guidance, /apiKey/)

    // 自动表单：auto=true 且 owner 必须是插件自己的 fiber
    assert.equal(configureCalls.length, 1)
    assert.deepEqual(configureCalls[0].policy, { auto: true })
    assert.equal(configureCalls[0].owner, ctx.fiber)
  })

  it('enabled=false 时不注册任何东西；announceToAgent=false 只去掉提示段', () => {
    const disabled = createContext({ settings: undefined })
    apply(disabled.ctx, { enabled: { get: () => false } })
    assert.equal(disabled.state.tools.size, 0)
    assert.equal(disabled.state.sections.size, 0)

    const quiet = createContext({ settings: undefined })
    apply(quiet.ctx, { announceToAgent: { get: () => false } })
    assert.equal(quiet.state.tools.size, 10)
    assert.equal(quiet.state.sections.size, 0)
  })

  it('设置变更后只在自家命名空间 re-sync', () => {
    const settings = { configure: () => () => {} }
    const { ctx, state, fire } = createContext({ settings })
    const { values, raw } = volatileConfig()
    apply(ctx, raw)
    assert.equal(state.tools.size, 10)

    // 别的插件保存配置：不受影响
    fire('dsh-mem0')
    assert.equal(state.tools.size, 10)
    assert.equal(state.sections.size, 1)

    // 自己的命名空间：按新配置重挂（这里关掉总开关）
    values.enabled = false
    fire(MNEMOS_SETTINGS_NAMESPACE)
    assert.equal(state.tools.size, 0)
    assert.equal(state.sections.size, 0)

    // 再打开：工具回来
    values.enabled = true
    fire(MNEMOS_SETTINGS_NAMESPACE)
    assert.equal(state.tools.size, 10)
    assert.equal(state.sections.size, 1)
  })

  it('没有 settings 服务（headless / CLI 挂载）时不抛异常，工具照常注册', () => {
    const { ctx, state } = createContext({ settings: undefined })
    assert.doesNotThrow(() => apply(ctx, Config({})))
    assert.equal(state.tools.size, 10)
    assert.equal(state.sections.size, 1)
  })

  it('settings 服务缺少 configure 方法时也能装配', () => {
    const { ctx, state } = createContext({ settings: {} })
    assert.doesNotThrow(() => apply(ctx, Config({})))
    assert.equal(state.tools.size, 10)
  })
})
