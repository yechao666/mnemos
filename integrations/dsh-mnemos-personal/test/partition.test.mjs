/**
 * 分区派生（工作区 → slug）单元测试。
 *
 * 重点：
 * - 同一路径 → 同一 slug（幂等建分区的前提）；
 * - 不同路径 → 不同 slug（即使 basename 相同，哈希段也不同）；
 * - basename 小写 + 去非法字符；根路径 / 中文目录有兜底；
 * - fixed 模式直接用配置值；缺 fixedPartition 时给出可操作错误；
 * - 会话工作区解析优先级：header.cwd > workingDirectory 服务 > 兜底目录。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  WorkspacePathError,
  normalizeWorkspacePath,
  resolveAgentWorkspacePath,
  resolvePartitionIdentity,
  workspaceName,
  workspaceSlug,
} from '../lib/workspace.js'

describe('normalizeWorkspacePath', () => {
  it('补成绝对路径并去掉尾部分隔符', () => {
    assert.equal(normalizeWorkspacePath('/Users/dev/project/'), '/Users/dev/project')
    assert.equal(normalizeWorkspacePath('/Users/dev/./project/../project'), '/Users/dev/project')
    assert.equal(normalizeWorkspacePath('  /Users/dev/project  '), '/Users/dev/project')
  })

  it('空路径抛 WorkspacePathError，并带可操作 action', () => {
    assert.throws(
      () => normalizeWorkspacePath('   '),
      (error) => {
        assert.ok(error instanceof WorkspacePathError)
        assert.equal(error.code, 'workspace_path_missing')
        assert.match(error.action, /partitionMode|fixedPartition/)
        return true
      },
    )
  })
})

describe('workspaceSlug', () => {
  it('slug = ws-<basename 小写>-<sha1 前 8 位>，同一路径稳定', () => {
    const path = '/Volumes/wd2025/devel/aiworker/mnemos'
    const first = workspaceSlug(path)
    const second = workspaceSlug(path)
    assert.equal(first, second)
    assert.match(first, /^ws-mnemos-[0-9a-f]{8}$/)
    assert.equal(first, workspaceSlug('/Volumes/wd2025/devel/aiworker/mnemos/'))
  })

  it('不同路径即使 basename 相同也隔离', () => {
    const a = workspaceSlug('/work/a/demo-project')
    const b = workspaceSlug('/work/b/demo-project')
    assert.notEqual(a, b)
    assert.match(a, /^ws-demo-project-[0-9a-f]{8}$/)
    assert.match(b, /^ws-demo-project-[0-9a-f]{8}$/)
  })

  it('basename 小写并把非法字符折叠成 -', () => {
    const slug = workspaceSlug('/work/My Project (v2)!')
    assert.match(slug, /^ws-my-project-v2-[0-9a-f]{8}$/)
  })

  it('纯中文 / 根路径等没法转成 ascii 的 basename 有兜底段', () => {
    assert.match(workspaceSlug('/work/我的项目'), /^ws-workspace-[0-9a-f]{8}$/)
    assert.match(workspaceSlug('/'), /^ws-workspace-[0-9a-f]{8}$/)
  })

  it('name 是路径最后一段', () => {
    assert.equal(workspaceName('/work/My Project'), 'My Project')
  })
})

describe('resolvePartitionIdentity', () => {
  it('workspace 模式从工作区派生 slug', () => {
    const identity = resolvePartitionIdentity('workspace', '', '/work/demo')
    assert.match(identity.slug, /^ws-demo-[0-9a-f]{8}$/)
    assert.equal(identity.name, 'demo')
  })

  it('workspace 模式缺路径时抛错并给出替代方案', () => {
    assert.throws(
      () => resolvePartitionIdentity('workspace', '', undefined),
      (error) => {
        assert.ok(error instanceof WorkspacePathError)
        assert.equal(error.code, 'workspace_path_missing')
        return true
      },
    )
  })

  it('fixed 模式直接使用 fixedPartition（原样，不 slug 化）', () => {
    const identity = resolvePartitionIdentity('fixed', '  mnemos-prod  ', '/work/demo')
    assert.deepEqual(identity, { slug: 'mnemos-prod', name: 'mnemos-prod' })
  })

  it('fixed 模式缺 fixedPartition 时抛可操作错误', () => {
    assert.throws(
      () => resolvePartitionIdentity('fixed', '   ', '/work/demo'),
      (error) => {
        assert.ok(error instanceof WorkspacePathError)
        assert.equal(error.code, 'fixed_partition_missing')
        assert.match(error.action, /fixedPartition/)
        return true
      },
    )
  })
})

describe('resolveAgentWorkspacePath', () => {
  it('优先用会话头 cwd（原始项目目录，回放稳定）', () => {
    const path = resolveAgentWorkspacePath(
      { session: { header: { cwd: '/work/header-project' } } },
      { workingDirectory: { get: () => '/work/service-project' }, fallbackDirectory: '/fallback' },
    )
    assert.equal(path, '/work/header-project')
  })

  it('没有会话头 cwd 时用 workingDirectory 服务的当前目录', () => {
    const path = resolveAgentWorkspacePath(
      { session: { id: 'sess_1' } },
      { workingDirectory: { get: () => '/work/service-project' }, fallbackDirectory: '/fallback' },
    )
    assert.equal(path, '/work/service-project')
  })

  it('两者都没有时回落到兜底目录；服务抛错也不影响', () => {
    assert.equal(resolveAgentWorkspacePath(undefined, { fallbackDirectory: '/fallback' }), '/fallback')
    assert.equal(
      resolveAgentWorkspacePath(
        { session: {} },
        {
          workingDirectory: {
            get: () => {
              throw new Error('disposed')
            },
          },
          fallbackDirectory: '/fallback',
        },
      ),
      '/fallback',
    )
  })
})
