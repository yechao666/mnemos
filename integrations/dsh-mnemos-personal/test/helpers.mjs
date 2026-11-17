/**
 * 测试辅助：node:test + 本地 `http.createServer` 假 Mnemos（v5 中立面），零额外依赖。
 *
 * 假服务实现插件用到的最小契约：
 * - POST/GET /v1/partitions（按 slug 幂等）
 * - PUT/GET /v1/partitions/:p/persons/:externalId、GET persons（列表）
 * - GET persons/:person/brief、POST persons/:person/context
 * - POST/GET memories、POST memories/search、GET memories/:id
 *
 * 不依赖真实 Mnemos：CI / 本机都能跑；真实后端联调属于下一轮安装验证。
 */

import http from 'node:http'

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

/** 一条记忆的读视图（假服务内部用）。 */
function memoryView(memory) {
  return { ...memory }
}

/** 人的读视图。 */
function personView(person) {
  return {
    id: person.id,
    external_id: person.external_id,
    type: person.type,
    display_name: person.display_name,
    attributes: person.attributes,
    status: person.status,
  }
}

/**
 * 起一个假 Mnemos v5 服务。
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] 期望的 Bearer key（默认 test_org_key）。
 * @param {boolean} [options.conflictOnExisting] 重复 POST /v1/partitions 时返回 409（默认 200 幂等）。
 * @param {boolean} [options.missingAdmin] POST /v1/partitions 返回 403（模拟没有 admin 的 org key）。
 * @param {Array<{method: string, path: string|RegExp, status?: number, code?: string, message?: string}>} [options.failures]
 *   注入失败：命中 method + path 的请求直接返回错误 JSON。
 */
export async function createMnemosFake(options = {}) {
  const apiKey = options.apiKey ?? 'test_org_key'
  const state = {
    partitions: new Map(), // slug -> { id, slug, name }
    persons: new Map(), // `${partitionSlug}/${externalId}` -> person
    memories: [], // 记忆对象（含 partition_slug）
    next: { partition: 1, person: 1, memory: 1 },
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

  function createPerson(partition, externalId, input = {}) {
    const person = {
      id: `prs_${state.next.person++}`,
      partition_slug: partition.slug,
      external_id: externalId,
      type: input.type ?? 'human',
      display_name: input.display_name ?? '',
      attributes: input.attributes ?? {},
      status: input.status ?? 'active',
    }
    state.persons.set(`${partition.slug}/${externalId}`, person)
    return person
  }

  function personMemories(partition, person) {
    return state.memories.filter(
      (memory) => memory.partition_slug === partition.slug && memory.person_external_id === person.external_id,
    )
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
        return sendJson(res, 200, { partition: existing })
      }
      const partition = { id: `prj_${state.next.partition++}`, slug, name: body?.name ?? slug }
      state.partitions.set(slug, partition)
      return sendJson(res, 200, { partition })
    }

    const partitionRef = decodeURIComponent(segments[2])
    const partition = findPartition(partitionRef)
    if (partition === undefined) {
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `partition not found: ${partitionRef}` } })
    }
    const rest = segments.slice(3).map((part) => decodeURIComponent(part))

    // /v1/partitions/:p
    if (rest.length === 0) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
      return sendJson(res, 200, { partition })
    }

    // /v1/partitions/:p/persons...
    if (rest[0] === 'persons') {
      if (rest.length === 1) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } })
        let people = [...state.persons.values()].filter((person) => person.partition_slug === partition.slug)
        if (typeof requestUrl.searchParams.get('type') === 'string') {
          people = people.filter((person) => person.type === requestUrl.searchParams.get('type'))
        }
        if (typeof requestUrl.searchParams.get('q') === 'string') {
          const keyword = requestUrl.searchParams.get('q')
          people = people.filter((person) => person.external_id.includes(keyword) || person.display_name.includes(keyword))
        }
        return sendJson(res, 200, { results: people.map(personView), count: people.length })
      }

      const personRef = rest[1]
      const personPath = rest.length >= 2 ? rest[1] : ''

      if (rest.length === 2) {
        if (req.method === 'PUT') {
          const existing = findPerson(partition, personPath)
          const normalized = body ?? {}
          if (existing === undefined) {
            const externalId = personPath
            return sendJson(res, 200, {
              person: personView(createPerson(partition, externalId, {
                type: normalized.type,
                display_name: normalized.display_name,
                attributes: normalized.attributes,
              })),
            })
          }
          if (normalized.type !== undefined) existing.type = normalized.type
          if (normalized.display_name !== undefined) existing.display_name = normalized.display_name
          if (normalized.attributes !== undefined) existing.attributes = normalized.attributes
          return sendJson(res, 200, { person: personView(existing) })
        }
        if (req.method === 'GET') {
          const person = findPerson(partition, personPath)
          if (person === undefined) {
            return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
          }
          const own = personMemories(partition, person)
          return sendJson(res, 200, {
            person: personView(person),
            stats: {
              memories: own.length,
              shared_memories: state.memories.filter((memory) => memory.partition_slug === partition.slug && memory.scope === 'partition').length,
              sessions: new Set(own.map((memory) => memory.session_id).filter(Boolean)).size,
            },
          })
        }
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or PUT' } })
      }

      if (rest.length === 3 && rest[2] === 'brief' && req.method === 'GET') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        const own = personMemories(partition, person)
        const text = own.length === 0 ? '' : `# 简报（person=${person.external_id}）\n${own.map((memory) => `- ${memory.content}`).join('\n')}`
        return sendJson(res, 200, {
          brief: { person_id: person.id, text, count: own.length, model: 'mnemos-condense', cached: false },
        })
      }

      if (rest.length === 3 && rest[2] === 'context' && req.method === 'POST') {
        const person = findPerson(partition, personPath)
        if (person === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `person not found: ${personPath}` } })
        }
        const own = personMemories(partition, person)
        const shared = state.memories.filter(
          (memory) => memory.partition_slug === partition.slug && memory.scope === 'partition',
        )
        const briefText = own.length === 0 ? '' : `# 简报（person=${person.external_id}）\n${own.map((memory) => `- ${memory.content}`).join('\n')}`
        return sendJson(res, 200, {
          person: personView(person),
          brief: { person_id: person.id, text: briefText, count: own.length },
          memories: own.map(memoryView),
          shared: shared.map(memoryView),
          prompt: `# 人物上下文（person=${person.external_id}，分区=${partition.slug}）\n${briefText}`,
          token_estimate: 42,
        })
      }

      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `unknown persons path ${rest.join('/')}` } })
    }

    // /v1/partitions/:p/memories...
    if (rest[0] === 'memories') {
      if (rest.length === 1) {
        if (req.method === 'POST') {
          const normalized = body ?? {}
          let person
          const personRef = normalized.person_id ?? normalized.person_external_id
          if (typeof personRef === 'string' && personRef !== '') {
            person = findPerson(partition, personRef)
            if (person === undefined) {
              person = createPerson(partition, personRef, { type: 'human' })
            }
          }
          const messageText = Array.isArray(normalized.messages)
            ? normalized.messages.map((message) => (typeof message === 'string' ? message : message?.content ?? '')).join('\n')
            : undefined
          const content = normalized.text ?? messageText ?? ''
          const memory = {
            id: `mem_${state.next.memory++}`,
            partition_slug: partition.slug,
            content,
            memory: content,
            person_id: person?.id,
            person_external_id: person?.external_id,
            actor_person_id: person?.id,
            session_id: normalized.session_id,
            scope: normalized.scope ?? 'partition',
            category: normalized.category ?? 'fact',
            status: 'active',
            tags: normalized.tags ?? [],
            metadata: normalized.metadata ?? {},
            created_at: '2026-11-17T00:00:00.000Z',
            updated_at: '2026-11-17T00:00:00.000Z',
          }
          state.memories.push(memory)
          return sendJson(res, 200, {
            results: [memoryView(memory)],
            events: [{ type: 'ADD', memoryId: memory.id, content: memory.content }],
            took_ms: 1,
          })
        }
        if (req.method === 'GET') {
          const scope = requestUrl.searchParams.get('scope')
          const category = requestUrl.searchParams.get('category')
          const personRef = requestUrl.searchParams.get('person_id')
          let matches = state.memories.filter((memory) => memory.partition_slug === partition.slug)
          if (typeof personRef === 'string' && personRef !== '') {
            const person = findPerson(partition, personRef)
            matches = matches.filter(
              (memory) => (person !== undefined && memory.person_external_id === person.external_id) || memory.scope === 'partition',
            )
          }
          if (typeof scope === 'string' && scope !== '') matches = matches.filter((memory) => memory.scope === scope)
          if (typeof category === 'string' && category !== '') matches = matches.filter((memory) => memory.category === category)
          const page = Math.max(1, Number(requestUrl.searchParams.get('page') ?? '1'))
          const pageSize = 20
          const start = (page - 1) * pageSize
          return sendJson(res, 200, {
            results: matches.slice(start, start + pageSize).map(memoryView),
            count: matches.length,
            page,
            page_size: pageSize,
          })
        }
        return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or POST' } })
      }

      if (rest.length === 2 && rest[1] === 'search' && req.method === 'POST') {
        const normalized = body ?? {}
        let matches = state.memories.filter((memory) => memory.partition_slug === partition.slug)
        const personRef = normalized.person_id
        if (typeof personRef === 'string' && personRef !== '') {
          const person = findPerson(partition, personRef)
          matches = matches.filter(
            (memory) => (person !== undefined && memory.person_external_id === person.external_id) || memory.scope === 'partition',
          )
        }
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
        const memory = state.memories.find((item) => item.partition_slug === partition.slug && item.id === rest[1])
        if (memory === undefined) {
          return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `memory not found: ${rest[1]}` } })
        }
        return sendJson(res, 200, { memory: memoryView(memory) })
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
      const partition = { id: `prj_${state.next.partition++}`, slug, name }
      state.partitions.set(slug, partition)
      return partition
    },
    /** 预置一个人（返回人对象）。 */
    seedPerson(partitionRef, externalId, input = {}) {
      const partition = findPartition(partitionRef)
      if (partition === undefined) throw new Error(`seedPerson: partition not found: ${partitionRef}`)
      const existing = findPerson(partition, externalId)
      if (existing !== undefined) return existing
      return createPerson(partition, externalId, input)
    },
    /** 按请求方法 + 路径前缀统计次数（断言幂等 / 缓存用）。 */
    countRequests(method, pathname) {
      return requests.filter((request) => request.method === method && request.pathname === pathname).length
    },
    close() {
      return closeServer(server)
    },
  }
}
