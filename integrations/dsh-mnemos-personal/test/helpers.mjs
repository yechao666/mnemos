/**
 * 测试辅助：node:test + 本地 `http.createServer` 假 Mnemos（**v6** API），零额外依赖。
 *
 * 假服务实现插件用到的最小 v6 契约（docs/v6-architecture.md 第 3 节）：
 * - POST /v1/partitions（按 slug 幂等 upsert）、GET /v1/partitions/:p、GET /v1/partitions/:p/stats
 * - GET /v1/partitions/:p/persons（**游标分页** cursor/limit/q/type/status/sort）
 * - PUT/GET/PATCH /v1/partitions/:p/persons/:person（person=内部 id 或 external）
 * - GET/POST /v1/partitions/:p/persons/:person/memories（该人记忆，游标分页）、
 *   GET .../brief、POST .../context、GET .../dream、POST .../dream/run
 * - GET /v1/partitions/:p/memories（全局列表，游标分页）、POST .../memories/search（检索；可用
 *   `searchEndpoint:false` 关掉以测「退化为列表 q 搜索」）、GET .../memories/:id
 *
 * 分页协议：响应 `{ items, next_cursor, partition_stats }`；游标是不透明字符串（base64url 的
 * 最后一条 id），第二页从游标项之后开始 —— 形状与真实 v6 一致，内部实现保持简单。
 *
 * 不依赖真实 Mnemos：CI / 本机都能跑；真实后端联调属于安装验证。
 */

import http from 'node:http'

/** 固定时间戳：让测试输出可复现。 */
const NOW = '2026-11-17T00:00:00.000Z'

/** 写 JSON 响应。 */
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** 关闭 mock 服务：先断开 keep-alive 连接，否则 server.close 会一直等。 */
export async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

/** 起一个通用 mock 服务，handler 自己决定怎么响应。 */
export async function startMock(handler) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: req.headers.authorization })
    try {
      await handler({ req, res, body, url, requests })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'mock_error', message: String(error) } })
      else res.end()
    }
  })
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
  return { server, url, requests }
}

/** 游标编解码：v6 里对插件是不透明字符串。 */
function encodeCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return undefined
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8')
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** limit 归一：v6 默认 50、上限 200。 */
function clampLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return 50
  return Math.min(Math.trunc(number), 200)
}

/** 一条记忆的读视图（深拷贝，防测试互相污染）。 */
function memoryView(memory) {
  return { ...memory }
}

/** 人的读视图（v6：计数反规范化在 persons 行上）。 */
function personView(person) {
  return {
    id: person.id,
    external_id: person.external_id,
    type: person.type,
    display_name: person.display_name,
    attributes: person.attributes,
    status: person.status,
    memory_count: person.memory_count,
    shared_memory_count: person.shared_memory_count,
    session_count: person.session_count,
    first_seen_at: person.first_seen_at,
    last_seen_at: person.last_seen_at,
    last_memory_at: person.last_memory_at,
    created_at: person.created_at,
    updated_at: person.updated_at,
  }
}

/** 分区统计（v6：直接读 partition_stats，不 COUNT(*)）。 */
function statsView(state, partition) {
  const people = [...state.persons.values()].filter((person) => person.partition_slug === partition.slug)
  const memories = state.memories.filter((memory) => memory.partition_slug === partition.slug)
  return {
    partition_id: partition.id,
    persons_total: people.length,
    persons_human: people.filter((person) => person.type === 'human').length,
    persons_agent: people.filter((person) => person.type === 'agent').length,
    persons_service: people.filter((person) => person.type === 'service').length,
    memories_total: memories.length,
    shared_total: memories.filter((memory) => memory.scope === 'partition').length,
    sessions_total: new Set(memories.map((memory) => memory.session_id).filter(Boolean)).size,
    updated_at: NOW,
  }
}

/**
 * 起一个假 Mnemos v6 服务。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 期望的 Bearer key（默认 test_org_key）。
 * @param {boolean} [options.conflictOnExisting] 重复 POST /v1/partitions 时返回 409（默认 200 幂等）。
 * @param {boolean} [options.missingAdmin] POST /v1/partitions 返回 403（模拟没有 admin 的 org key）。
 * @param {boolean} [options.searchEndpoint] 是否实现 POST .../memories/search（默认 true；
 *   false 时返回 404，用于验证插件退化为 `GET .../memories?q=` 全文搜索）。
 * @param {Array<{method: string, path: string|RegExp, status?: number, code?: string, message?: string}>} [options.failures]
 *   注入失败：命中 method + path 的请求直接返回错误 JSON。
 */
export async function createMnemosFake(options = {}) {
  const apiKey = options.apiKey ?? 'test_org_key'
  const state = {
    partitions: new Map(), // slug -> { id, slug, name, description, status, settings }
    persons: new Map(), // `${partitionSlug}/${externalId}` -> person
    memories: [], // 记忆对象（含 partition_slug / person_external_id）
    dreams: new Map(), // `${partitionSlug}/${externalId}` -> dream 状态
    next: { partition: 1, person: 1, memory: 1, dream: 1 },
  }

  function findPartition(ref) {
    for (const partition of state.partitions.values()) {
      if (partition.slug === ref || partition.id === ref) return partition
    }
    return undefined
  }

  function findPerson(partition, ref) {
    if (partition === undefined) return undefined
    for (const person of state.persons.values()) {
      if (person.partition_slug === partition.slug && (person.id === ref || person.external_id === ref)) return person
    }
    return undefined
  }

  function personsIn(partition) {
    return [...state.persons.values()].filter((person) => person.partition_slug === partition.slug)
  }

  function memoriesIn(partition) {
    return state.memories.filter((memory) => memory.partition_slug === partition.slug)
  }

  /** 重算某个人的反规范化计数（v6：写入时维护，不逐行 COUNT）。 */
  function refreshPerson(person) {
    const own = state.memories.filter(
      (memory) => memory.partition_slug === person.partition_slug && memory.person_external_id === person.external_id,
    )
    person.memory_count = own.filter((memory) => memory.scope === 'person' || memory.scope === 'session').length
    person.shared_memory_count = own.filter((memory) => memory.scope === 'partition').length
    person.session_count = new Set(own.map((memory) => memory.session_id).filter(Boolean)).size
    person.last_memory_at = own.length > 0 ? own[own.length - 1].created_at : null
    person.updated_at = NOW
    return person
  }

  function createPerson(partition, externalId, input = {}) {
    const existing = findPerson(partition, externalId)
    if (existing !== undefined) {
      if (input.type !== undefined) existing.type = input.type
      if (input.display_name !== undefined) existing.display_name = input.display_name
      if (input.attributes !== undefined) existing.attributes = input.attributes
      if (input.status !== undefined) existing.status = input.status
      existing.updated_at = NOW
      existing.last_seen_at = NOW
      return existing
    }
    const person = {
      id: `prs_${state.next.person++}`,
      partition_slug: partition.slug,
      partition_id: partition.id,
      external_id: externalId,
      type: input.type ?? 'human',
      display_name: input.display_name ?? '',
      attributes: input.attributes ?? {},
      status: input.status ?? 'active',
      memory_count: 0,
      shared_memory_count: 0,
      session_count: 0,
      first_seen_at: NOW,
      last_seen_at: NOW,
      last_memory_at: null,
      created_at: NOW,
      updated_at: NOW,
    }
    state.persons.set(`${partition.slug}/${externalId}`, person)
    return person
  }

  function createMemory(partition, person, input = {}) {
    const messageText = Array.isArray(input.messages)
      ? input.messages
          .map((message) => (typeof message === 'string' ? message : message?.content ?? ''))
          .join('\n')
      : undefined
    const content = input.text ?? messageText ?? ''
    const memory = {
      id: `mem_${state.next.memory++}`,
      partition_id: partition.id,
      partition_slug: partition.slug,
      person_id: person.id,
      person_external_id: person.external_id,
      actor_person_id: person.id,
      content,
      scope: input.scope ?? 'partition',
      session_id: input.session_id ?? null,
      category: input.category ?? 'fact',
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      source: 'api',
      status: 'active',
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      created_at: NOW,
      updated_at: NOW,
      expires_at: null,
      dreamed_at: null,
    }
    state.memories.push(memory)
    person.last_seen_at = NOW
    refreshPerson(person)
    return memory
  }

  /** 游标分页：从游标项之后取 limit 条。 */
  function paginate(items, cursor, limit, idOf = (item) => item.id) {
    const size = clampLimit(limit)
    let start = 0
    const cursorId = decodeCursor(cursor)
    if (cursorId !== undefined) {
      const index = items.findIndex((item) => idOf(item) === cursorId)
      if (index >= 0) start = index + 1
    }
    const slice = items.slice(start, start + size)
    const hasMore = start + size < items.length
    return {
      items: slice,
      next_cursor: hasMore && slice.length > 0 ? encodeCursor(idOf(slice[slice.length - 1])) : undefined,
    }
  }

  /** 该人自己写的记忆（人不为空时）。 */
  function ownedMemories(partition, person) {
    return memoriesIn(partition).filter((memory) => memory.person_external_id === person.external_id)
  }

  function briefFor(partition, person) {
    const own = ownedMemories(partition, person).filter((memory) => memory.scope !== 'partition')
    const text = own.length === 0 ? '' : `# 简报（person=${person.external_id}）\n${own.map((memory) => `- ${memory.content}`).join('\n')}`
    return {
      person_id: person.id,
      person_external_id: person.external_id,
      text,
      count: own.length,
      max_chars: 1200,
      model: 'mnemos-condense',
      source_hash: `hash_${person.external_id}`,
      generated_at: NOW,
      cached: false,
    }
  }

  const { server, url, requests } = await startMock(async ({ req, res, body, url: requestUrl }) => {
    const pathname = requestUrl.pathname

    const failure = (options.failures ?? []).find(
      (item) => item.method === req.method && (typeof item.path === 'string' ? item.path === pathname : item.path.test(pathname)),
    )
    if (failure !== undefined) {
      return sendJson(res, failure.status ?? 500, {
        error: { code: failure.code ?? 'FORBIDDEN', message: failure.message ?? 'injected failure' },
      })
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return sendJson(res, 401, { error: { code: 'INVALID_API_KEY', message: 'invalid api key' } })
    }

    const segments = pathname.split('/').filter((part) => part !== '')
    if (segments[0] !== 'v1' || segments[1] !== 'partitions') {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown path ${pathname}` } })
    }

    // POST /v1/partitions
    if (segments.length === 2) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST' } })
      if (options.missingAdmin === true) {
        return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'org key lacks admin' } })
      }
      const slug = body?.slug
      if (typeof slug !== 'string' || slug === '') {
        return sendJson(res, 400, { error: { code: 'VALIDATION_ERROR', message: 'slug is required' } })
      }
      const existing = state.partitions.get(slug)
      if (existing !== undefined) {
        if (options.conflictOnExisting === true) {
          return sendJson(res, 409, { error: { code: 'CONFLICT', message: 'partition exists' } })
        }
        return sendJson(res, 200, existing)
      }
      const partition = {
        id: `ptn_${state.next.partition++}`,
        slug,
        name: body?.name ?? slug,
        description: body?.description ?? '',
        status: 'active',
        settings: {},
      }
      state.partitions.set(slug, partition)
      return sendJson(res, 200, partition)
    }

    // :partition 支持内部 id 或 slug。
    const partitionRef = decodeURIComponent(segments[2])
    const partition = findPartition(partitionRef)
    if (partition === undefined) {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `partition not found: ${partitionRef}` } })
    }
    const rest = segments.slice(3).map((part) => decodeURIComponent(part))

    // /v1/partitions/:p
    if (rest.length === 0) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
      return sendJson(res, 200, partition)
    }

    // /v1/partitions/:p/stats
    if (rest.length === 1 && rest[0] === 'stats') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
      return sendJson(res, 200, statsView(state, partition))
    }

    // /v1/partitions/:p/persons...
    if (rest[0] === 'persons') {
      if (rest.length === 1) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
        let people = personsIn(partition)
        const type = requestUrl.searchParams.get('type')
        const status = requestUrl.searchParams.get('status')
        const q = requestUrl.searchParams.get('q')
        const sort = requestUrl.searchParams.get('sort') ?? 'recent'
        if (typeof type === 'string' && type !== '') people = people.filter((person) => person.type === type)
        if (typeof status === 'string' && status !== '') people = people.filter((person) => person.status === status)
        if (typeof q === 'string' && q !== '') {
          const keyword = q.toLowerCase()
          people = people.filter(
            (person) =>
              person.external_id.toLowerCase().includes(keyword) || person.display_name.toLowerCase().includes(keyword),
          )
        }
        people = people.sort((a, b) => {
          if (sort === 'name') {
            return String(a.display_name).localeCompare(String(b.display_name)) || a.id.localeCompare(b.id)
          }
          if (sort === 'new') {
            return String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id)
          }
          // recent（默认）：最近活跃优先，id 做稳定次序。
          return String(b.last_seen_at).localeCompare(String(a.last_seen_at)) || b.id.localeCompare(a.id)
        })
        const page = paginate(people, requestUrl.searchParams.get('cursor'), requestUrl.searchParams.get('limit'))
        return sendJson(res, 200, {
          items: page.items.map(personView),
          next_cursor: page.next_cursor,
          partition_stats: statsView(state, partition),
        })
      }

      const personPath = rest[1]

      // /persons/:externalId（建档 / 更新）与 /persons/:person（详情 / 更新）
      if (rest.length === 2) {
        if (req.method === 'PUT') {
          const normalized = body ?? {}
          const person = createPerson(partition, personPath, normalized)
          refreshPerson(person)
          return sendJson(res, 200, personView(person))
        }
        if (req.method === 'PATCH') {
          const person = findPerson(partition, personPath)
          if (person === undefined) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
          }
          const normalized = body ?? {}
          if (normalized.type !== undefined) person.type = normalized.type
          if (normalized.display_name !== undefined) person.display_name = normalized.display_name
          if (normalized.attributes !== undefined) person.attributes = normalized.attributes
          if (normalized.status !== undefined) person.status = normalized.status
          person.updated_at = NOW
          return sendJson(res, 200, personView(person))
        }
        if (req.method === 'GET') {
          const person = findPerson(partition, personPath)
          if (person === undefined) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
          }
          return sendJson(res, 200, personView(person))
        }
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET / PUT / PATCH' } })
      }

      // /persons/:person/memories
      if (rest.length === 3 && rest[2] === 'memories') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        if (req.method === 'POST') {
          const memory = createMemory(partition, person, body ?? {})
          return sendJson(res, 201, {
            memory: memoryView(memory),
            events: [{ type: 'ADD', memory_id: memory.id, at: NOW }],
          })
        }
        if (req.method === 'GET') {
          let matches = ownedMemories(partition, person)
          const scope = requestUrl.searchParams.get('scope')
          const category = requestUrl.searchParams.get('category')
          const q = requestUrl.searchParams.get('q')
          if (typeof scope === 'string' && scope !== '') matches = matches.filter((memory) => memory.scope === scope)
          if (typeof category === 'string' && category !== '') {
            matches = matches.filter((memory) => memory.category === category)
          }
          if (typeof q === 'string' && q !== '') {
            const keyword = q.toLowerCase()
            matches = matches.filter((memory) => memory.content.toLowerCase().includes(keyword))
          }
          matches = [...matches].sort(
            (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id),
          )
          const page = paginate(matches, requestUrl.searchParams.get('cursor'), requestUrl.searchParams.get('limit'))
          return sendJson(res, 200, {
            items: page.items.map(memoryView),
            next_cursor: page.next_cursor,
            partition_stats: statsView(state, partition),
          })
        }
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or POST' } })
      }

      if (rest.length === 3 && rest[2] === 'brief' && req.method === 'GET') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        return sendJson(res, 200, briefFor(partition, person))
      }

      if (rest.length === 3 && rest[2] === 'context' && req.method === 'POST') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        const own = ownedMemories(partition, person)
        const shared = memoriesIn(partition).filter((memory) => memory.scope === 'partition')
        const brief = briefFor(partition, person)
        return sendJson(res, 200, {
          person: personView(person),
          brief,
          memories: own.map(memoryView),
          shared: shared.map(memoryView),
          prompt: `# 人物上下文（person=${person.external_id}，分区=${partition.slug}）\n${brief.text}`,
          token_estimate: 42,
        })
      }

      if (rest.length === 3 && rest[2] === 'dream' && req.method === 'GET') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        const stored = state.dreams.get(`${partition.slug}/${person.external_id}`)
        return sendJson(res, 200, {
          settings: { enabled: true, interval_minutes: 60, last_at: stored?.last_run_at ?? null },
          person_id: person.id,
          pending_count: 0,
          last_run: stored?.last_run ?? null,
          runs: stored?.runs ?? [],
        })
      }

      if (rest.length === 4 && rest[2] === 'dream' && rest[3] === 'run' && req.method === 'POST') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        const run = {
          id: `dr_${state.next.dream++}`,
          person_id: person.id,
          person_external_id: person.external_id,
          status: 'succeeded',
          trigger: 'manual',
          input_count: ownedMemories(partition, person).length,
          insight_count: 0,
          summary: 'mock dream run',
          started_at: NOW,
          finished_at: NOW,
        }
        state.dreams.set(`${partition.slug}/${person.external_id}`, {
          last_run_at: NOW,
          last_run: {
            id: run.id,
            partition_id: partition.id,
            person_id: person.id,
            trigger: 'manual',
            status: 'succeeded',
            input_count: run.input_count,
            insight_count: 0,
            summary: run.summary,
            error: null,
            started_at: NOW,
            finished_at: NOW,
          },
          runs: [],
        })
        return sendJson(res, 200, {
          run: state.dreams.get(`${partition.slug}/${person.external_id}`).last_run,
          status: {
            settings: { enabled: true, interval_minutes: 60, last_at: NOW },
            person_id: person.id,
            pending_count: 0,
            last_run: state.dreams.get(`${partition.slug}/${person.external_id}`).last_run,
            runs: [],
          },
        })
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown persons path ${rest.join('/')}` } })
    }

    // /v1/partitions/:p/memories...
    if (rest[0] === 'memories') {
      if (rest.length === 1) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
        const scope = requestUrl.searchParams.get('scope')
        const category = requestUrl.searchParams.get('category')
        const personRef = requestUrl.searchParams.get('person_id')
        const q = requestUrl.searchParams.get('q')
        // v6：GET /memories 的 person_id 是**作者过滤**（该人写的记忆），不是「该人可见」。
        const person = typeof personRef === 'string' && personRef !== '' ? findPerson(partition, personRef) : undefined
        let matches =
          typeof personRef === 'string' && personRef !== ''
            ? person === undefined
              ? []
              : ownedMemories(partition, person)
            : memoriesIn(partition)
        if (typeof scope === 'string' && scope !== '') matches = matches.filter((memory) => memory.scope === scope)
        if (typeof category === 'string' && category !== '') {
          matches = matches.filter((memory) => memory.category === category)
        }
        if (typeof q === 'string' && q !== '') {
          const keyword = q.toLowerCase()
          matches = matches.filter((memory) => memory.content.toLowerCase().includes(keyword))
        }
        matches = [...matches].sort(
          (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id),
        )
        const page = paginate(matches, requestUrl.searchParams.get('cursor'), requestUrl.searchParams.get('limit'))
        return sendJson(res, 200, {
          items: page.items.map(memoryView),
          next_cursor: page.next_cursor,
          partition_stats: statsView(state, partition),
        })
      }

      if (rest.length === 2 && rest[1] === 'search' && req.method === 'POST') {
        if (options.searchEndpoint === false) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'search endpoint removed in v6' } })
        }
        const normalized = body ?? {}
        const person =
          typeof normalized.person_id === 'string' && normalized.person_id !== ''
            ? findPerson(partition, normalized.person_id)
            : undefined
        // v6 的 POST /memories/search = listMemories + q：person_id 是作者过滤（不含别人的共享）。
        let matches =
          typeof normalized.person_id === 'string' && normalized.person_id !== ''
            ? person === undefined
              ? []
              : ownedMemories(partition, person)
            : memoriesIn(partition)
        if (typeof normalized.scope === 'string' && normalized.scope !== '') {
          matches = matches.filter((memory) => memory.scope === normalized.scope)
        }
        if (typeof normalized.category === 'string' && normalized.category !== '') {
          matches = matches.filter((memory) => memory.category === normalized.category)
        }
        const topK = typeof normalized.top_k === 'number' ? normalized.top_k : 8
        return sendJson(res, 200, {
          results: matches.slice(0, topK).map((memory) => ({ ...memoryView(memory), score: 0.91, matched_on: ['semantic'] })),
          took_ms: 3,
          signals: {},
        })
      }

      if (rest.length === 2 && req.method === 'GET') {
        const memory = state.memories.find(
          (item) => item.partition_slug === partition.slug && item.id === rest[1],
        )
        if (memory === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `memory not found: ${rest[1]}` } })
        }
        const owner = findPerson(partition, memory.person_external_id)
        return sendJson(res, 200, { memory: memoryView(memory), person: owner ? personView(owner) : null })
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown memories path ${rest.join('/')}` } })
    }

    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown path ${pathname}` } })
  })

  return {
    server,
    url,
    state,
    requests,
    /** 预置一个分区（返回分区对象）。 */
    seedPartition(slug, name = slug) {
      const partition = { id: `ptn_${state.next.partition++}`, slug, name, description: '', status: 'active', settings: {} }
      state.partitions.set(slug, partition)
      return partition
    },
    /** 预置一个人（返回人对象）。 */
    seedPerson(partitionRef, externalId, input = {}) {
      const partition = findPartition(partitionRef)
      if (partition === undefined) throw new Error(`seedPerson: partition not found: ${partitionRef}`)
      const person = createPerson(partition, externalId, input)
      refreshPerson(person)
      return person
    },
    /** 预置一条记忆（返回记忆对象）。 */
    seedMemory(partitionRef, personExternalId, content, input = {}) {
      const partition = findPartition(partitionRef)
      if (partition === undefined) throw new Error(`seedMemory: partition not found: ${partitionRef}`)
      const person = createPerson(partition, personExternalId, { type: input.type })
      return createMemory(partition, person, { ...input, text: content })
    },
    /** 按请求方法 + 路径统计次数（断言幂等 / 缓存用）。 */
    countRequests(method, pathname) {
      return requests.filter((request) => request.method === method && request.pathname === pathname).length
    },
    close() {
      return closeServer(server)
    },
  }
}
