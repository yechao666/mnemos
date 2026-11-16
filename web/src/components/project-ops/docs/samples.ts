export type DocLang = 'curl' | 'typescript' | 'python';

/** 快速开始：环境准备 + 健康检查。 */
export function quickstartSample(baseUrl: string, lang: DocLang): string {
  if (lang === 'curl') {
    return [
      `export MNEMOS_BASE_URL="${baseUrl}"`,
      'export MNEMOS_API_KEY="mnemos_live_xxxxxxxx"',
      '',
      'curl -sS "$MNEMOS_BASE_URL/api/health"',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      `const BASE_URL = '${baseUrl}';`,
      'const API_KEY = process.env.MNEMOS_API_KEY!;',
      '',
      'async function health() {',
      "  const res = await fetch(BASE_URL + '/api/health');",
      '  return res.json();',
      '}',
    ].join('\n');
  }
  return [
    'import os',
    'import requests',
    '',
    `BASE_URL = "${baseUrl}"`,
    'API_KEY = os.environ["MNEMOS_API_KEY"]',
    '',
    'def health():',
    '    return requests.get(f"{BASE_URL}/api/health").json()',
  ].join('\n');
}

/** 认证：带 Bearer 的受保护请求。 */
export function authSample(lang: DocLang): string {
  if (lang === 'curl') {
    return [
      'curl "$MNEMOS_BASE_URL/v1/stats" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY"',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      "const res = await fetch(BASE_URL + '/v1/stats', {",
      "  headers: { Authorization: 'Bearer ' + API_KEY },",
      '});',
      'const stats = await res.json();',
    ].join('\n');
  }
  return [
    'res = requests.get(',
    '    f"{BASE_URL}/v1/stats",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    ')',
    'stats = res.json()',
  ].join('\n');
}

/** 记忆写入。 */
export function addSample(baseUrl: string, projectId: string, lang: DocLang): string {
  if (lang === 'curl') {
    const body = JSON.stringify(
      {
        messages: [
          { role: 'user', content: '我偏好深色模式' },
          { role: 'assistant', content: '已记住这个偏好' },
        ],
        project_id: projectId,
        user_id: 'user_123',
        agent_id: 'dsh-agent',
        metadata: { source: 'console' },
        infer: true,
      },
      null,
      2,
    );
    return [
      'curl -X POST "$MNEMOS_BASE_URL/v1/memories" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`,
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      `const PROJECT_ID = '${projectId}';`,
      '',
      "const res = await fetch(BASE_URL + '/v1/memories', {",
      "  method: 'POST',",
      '  headers: {',
      "    Authorization: 'Bearer ' + API_KEY,",
      "    'Content-Type': 'application/json',",
      '  },',
      '  body: JSON.stringify({',
      '    messages: [',
      "      { role: 'user', content: '我偏好深色模式' },",
      "      { role: 'assistant', content: '已记住这个偏好' },",
      '    ],',
      '    project_id: PROJECT_ID,',
      "    user_id: 'user_123',",
      "    agent_id: 'dsh-agent',",
      "    metadata: { source: 'console' },",
      '    infer: true,',
      '  }),',
      '});',
      'const data = await res.json();',
    ].join('\n');
  }
  return [
    `PROJECT_ID = "${projectId}"`,
    '',
    'res = requests.post(',
    '    f"{BASE_URL}/v1/memories",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    '    json={',
    '        "messages": [',
    '            {"role": "user", "content": "我偏好深色模式"},',
    '            {"role": "assistant", "content": "已记住这个偏好"},',
    '        ],',
    '        "project_id": PROJECT_ID,',
    '        "user_id": "user_123",',
    '        "agent_id": "dsh-agent",',
    '        "metadata": {"source": "console"},',
    '        "infer": True,',
    '    },',
    ')',
    'data = res.json()',
  ].join('\n');
}

/** 记忆检索（混合检索信号）。 */
export function searchSample(baseUrl: string, projectId: string, lang: DocLang): string {
  if (lang === 'curl') {
    const body = JSON.stringify(
      {
        query: '我喜欢的界面主题',
        project_id: projectId,
        user_id: 'user_123',
        top_k: 5,
        threshold: 0.2,
        filters: {
          status: 'active',
          category: 'preference',
        },
      },
      null,
      2,
    );
    return [
      'curl -X POST "$MNEMOS_BASE_URL/v1/memories/search" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${body}'`,
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      `const PROJECT_ID = '${projectId}';`,
      '',
      "const res = await fetch(BASE_URL + '/v1/memories/search', {",
      "  method: 'POST',",
      '  headers: {',
      "    Authorization: 'Bearer ' + API_KEY,",
      "    'Content-Type': 'application/json',",
      '  },',
      '  body: JSON.stringify({',
      "    query: '我喜欢的界面主题',",
      '    project_id: PROJECT_ID,',
      "    user_id: 'user_123',",
      '    top_k: 5,',
      '    threshold: 0.2,',
      "    filters: { status: 'active', category: 'preference' },",
      '  }),',
      '});',
      'const data = await res.json();',
    ].join('\n');
  }
  return [
    `PROJECT_ID = "${projectId}"`,
    '',
    'res = requests.post(',
    '    f"{BASE_URL}/v1/memories/search",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    '    json={',
    '        "query": "我喜欢的界面主题",',
    '        "project_id": PROJECT_ID,',
    '        "user_id": "user_123",',
    '        "top_k": 5,',
    '        "threshold": 0.2,',
    '        "filters": {"status": "active", "category": "preference"},',
    '    },',
    ')',
    'data = res.json()',
  ].join('\n');
}

/** 记忆管理：读取 / 更新 / 删除 / 批量删除。 */
export function manageSample(lang: DocLang): string {
  if (lang === 'curl') {
    return [
      'MEMORY_ID="mem_xxxxxxxx"',
      '',
      '# 读取',
      'curl "$MNEMOS_BASE_URL/v1/memories/$MEMORY_ID" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY"',
      '',
      '# 更新',
      'curl -X PUT "$MNEMOS_BASE_URL/v1/memories/$MEMORY_ID" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"content":"用户偏好深色模式","importance":0.9}\'',
      '',
      '# 删除单条',
      'curl -X DELETE "$MNEMOS_BASE_URL/v1/memories/$MEMORY_ID" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY"',
      '',
      '# 批量删除（必须显式 confirm）',
      'curl -X POST "$MNEMOS_BASE_URL/v1/memories/batch" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"action":"delete","ids":["mem_1","mem_2"],"confirm":true}\'',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      "const MEMORY_ID = 'mem_xxxxxxxx';",
      '',
      '// 读取',
      'const memory = await fetch(BASE_URL + \'/v1/memories/\' + MEMORY_ID, {',
      "  headers: { Authorization: 'Bearer ' + API_KEY },",
      '}).then((res) => res.json());',
      '',
      '// 更新',
      'await fetch(BASE_URL + \'/v1/memories/\' + MEMORY_ID, {',
      "  method: 'PUT',",
      "  headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },",
      "  body: JSON.stringify({ content: '用户偏好深色模式', importance: 0.9 }),",
      '});',
      '',
      '// 删除单条',
      'await fetch(BASE_URL + \'/v1/memories/\' + MEMORY_ID, {',
      "  method: 'DELETE',",
      "  headers: { Authorization: 'Bearer ' + API_KEY },",
      '});',
      '',
      '// 批量删除（必须显式 confirm）',
      'await fetch(BASE_URL + \'/v1/memories/batch\', {',
      "  method: 'POST',",
      "  headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },",
      "  body: JSON.stringify({ action: 'delete', ids: ['mem_1', 'mem_2'], confirm: true }),",
      '});',
    ].join('\n');
  }
  return [
    'MEMORY_ID = "mem_xxxxxxxx"',
    '',
    '# 读取',
    'memory = requests.get(',
    '    f"{BASE_URL}/v1/memories/{MEMORY_ID}",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    ').json()',
    '',
    '# 更新',
    'requests.put(',
    '    f"{BASE_URL}/v1/memories/{MEMORY_ID}",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    '    json={"content": "用户偏好深色模式", "importance": 0.9},',
    ')',
    '',
    '# 删除单条',
    'requests.delete(',
    '    f"{BASE_URL}/v1/memories/{MEMORY_ID}",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    ')',
    '',
    '# 批量删除（必须显式 confirm）',
    'requests.post(',
    '    f"{BASE_URL}/v1/memories/batch",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    '    json={"action": "delete", "ids": ["mem_1", "mem_2"], "confirm": True},',
    ')',
  ].join('\n');
}

/** 图谱查询。 */
export function graphSample(lang: DocLang): string {
  if (lang === 'curl') {
    return [
      'curl "$MNEMOS_BASE_URL/v1/graph?limit=120" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY"',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      "const res = await fetch(BASE_URL + '/v1/graph?limit=120', {",
      "  headers: { Authorization: 'Bearer ' + API_KEY },",
      '});',
      'const graph = await res.json();',
    ].join('\n');
  }
  return [
    'res = requests.get(',
    '    f"{BASE_URL}/v1/graph",',
    '    params={"limit": 120},',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    ')',
    'graph = res.json()',
  ].join('\n');
}

/** 项目统计。 */
export function statsSample(lang: DocLang): string {
  if (lang === 'curl') {
    return [
      'curl "$MNEMOS_BASE_URL/v1/stats" \\',
      '  -H "Authorization: Bearer $MNEMOS_API_KEY"',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      "const res = await fetch(BASE_URL + '/v1/stats', {",
      "  headers: { Authorization: 'Bearer ' + API_KEY },",
      '});',
      'const stats = await res.json();',
    ].join('\n');
  }
  return [
    'res = requests.get(',
    '    f"{BASE_URL}/v1/stats",',
    '    headers={"Authorization": f"Bearer {API_KEY}"},',
    ')',
    'stats = res.json()',
  ].join('\n');
}

/**
 * 记忆简报（控制台 API）：读取简报 + 更新字符上限。
 *
 * 控制台接口使用会话令牌（`/api/auth/login` 返回的 `token`），不是 `mnemos_live_*` API Key。
 */
export function briefSample(baseUrl: string, projectId: string, lang: DocLang): string {
  if (lang === 'curl') {
    return [
      `PROJECT_ID="${projectId}"`,
      '# 控制台接口使用会话令牌：POST /api/auth/login → { token }',
      'SESSION="$MNEMOS_SESSION_TOKEN"',
      '',
      '# 读取简报：maxChars 临时覆盖项目设置，force=1 跳过缓存',
      'curl "$MNEMOS_BASE_URL/api/projects/$PROJECT_ID/memory/brief?maxChars=800&force=1" \\',
      '  -H "Authorization: Bearer $SESSION"',
      '',
      '# 更新项目简报字数上限（100–5000），返回重新生成后的简报',
      'curl -X PATCH "$MNEMOS_BASE_URL/api/projects/$PROJECT_ID/memory/brief" \\',
      '  -H "Authorization: Bearer $SESSION" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"maxChars":1200}\'',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      `const BASE_URL = '${baseUrl}';`,
      `const PROJECT_ID = '${projectId}';`,
      'const SESSION = process.env.MNEMOS_SESSION_TOKEN!; // 登录 /api/auth/login 获取',
      '',
      '// 读取简报：不传 agentId = 审计全量；传 agentId = 该 Agent 视角（项目共享 + 其私有）',
      'const brief = await fetch(',
      '  `${BASE_URL}/api/projects/${PROJECT_ID}/memory/brief?maxChars=800`,',
      "  { headers: { Authorization: `Bearer ${SESSION}` } },",
      ').then((res) => res.json());',
      'console.log(brief.count, brief.maxChars);',
      '',
      '// 更新字数上限（100–5000）',
      'await fetch(`${BASE_URL}/api/projects/${PROJECT_ID}/memory/brief`, {',
      "  method: 'PATCH',",
      '  headers: { Authorization: `Bearer ${SESSION}`, \'Content-Type\': \'application/json\' },',
      '  body: JSON.stringify({ maxChars: 1200 }),',
      '});',
    ].join('\n');
  }
  return [
    'import os',
    'import requests',
    '',
    `BASE_URL = "${baseUrl}"`,
    `PROJECT_ID = "${projectId}"`,
    'SESSION = os.environ["MNEMOS_SESSION_TOKEN"]  # 登录 /api/auth/login 获取',
    'HEADERS = {"Authorization": f"Bearer {SESSION}"}',
    '',
    '# 读取简报：不传 agentId = 审计全量；传 agentId = 该 Agent 视角（项目共享 + 其私有）',
    'brief = requests.get(',
    '    f"{BASE_URL}/api/projects/{PROJECT_ID}/memory/brief",',
    '    params={"maxChars": 800},',
    '    headers=HEADERS,',
    ').json()',
    'print(brief["count"], brief["maxChars"])',
    '',
    '# 更新字数上限（100–5000）',
    'requests.patch(',
    '    f"{BASE_URL}/api/projects/{PROJECT_ID}/memory/brief",',
    '    json={"maxChars": 1200},',
    '    headers=HEADERS,',
    ')',
  ].join('\n');
}

/** 记忆复盘总结（控制台 API）：状态 / 设置 / 手动触发。 */
export function dreamSample(baseUrl: string, projectId: string, lang: DocLang): string {
  if (lang === 'curl') {
    return [
      `PROJECT_ID="${projectId}"`,
      'SESSION="$MNEMOS_SESSION_TOKEN" # 控制台接口传会话令牌，不是 API Key',
      '',
      '# 1) 读取状态：settings / pendingCount / 最近 10 次运行记录',
      'curl "$MNEMOS_BASE_URL/api/projects/$PROJECT_ID/memory/dream" \\',
      '  -H "Authorization: Bearer $SESSION"',
      '',
      '# 2) 更新设置：enabled 与 intervalMinutes 至少提供一个（1–43200 分钟）',
      'curl -X PATCH "$MNEMOS_BASE_URL/api/projects/$PROJECT_ID/memory/dream" \\',
      '  -H "Authorization: Bearer $SESSION" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"enabled":true,"intervalMinutes":720}\'',
      '',
      '# 3) 手动触发一次增量复盘总结；运行中返回 409 CONFLICT',
      'curl -X POST "$MNEMOS_BASE_URL/api/projects/$PROJECT_ID/memory/dream/run" \\',
      '  -H "Authorization: Bearer $SESSION"',
    ].join('\n');
  }
  if (lang === 'typescript') {
    return [
      `const BASE_URL = '${baseUrl}';`,
      `const PROJECT_ID = '${projectId}';`,
      'const SESSION = process.env.MNEMOS_SESSION_TOKEN!;',
      'const auth = { Authorization: `Bearer ${SESSION}` };',
      '',
      '// 状态：settings、尚未复盘总结的项目共享记忆数、最近运行记录',
      'const status = await fetch(',
      '  `${BASE_URL}/api/projects/${PROJECT_ID}/memory/dream`,',
      '  { headers: auth },',
      ').then((res) => res.json());',
      'console.log(status.pendingCount, status.runs.length);',
      '',
      '// 更新设置',
      'await fetch(`${BASE_URL}/api/projects/${PROJECT_ID}/memory/dream`, {',
      "  method: 'PATCH',",
      '  headers: { ...auth, \'Content-Type\': \'application/json\' },',
      '  body: JSON.stringify({ enabled: true, intervalMinutes: 720 }),',
      '});',
      '',
      '// 手动触发一次（运行中返回 409）',
      'const result = await fetch(`${BASE_URL}/api/projects/${PROJECT_ID}/memory/dream/run`, {',
      "  method: 'POST',",
      '  headers: auth,',
      '}).then((res) => res.json());',
      'console.log(result.run?.inputCount, result.run?.insightCount);',
    ].join('\n');
  }
  return [
    'import os',
    'import requests',
    '',
    `BASE_URL = "${baseUrl}"`,
    `PROJECT_ID = "${projectId}"`,
    'SESSION = os.environ["MNEMOS_SESSION_TOKEN"]',
    'HEADERS = {"Authorization": f"Bearer {SESSION}"}',
    '',
    '# 状态：settings、尚未复盘总结的项目共享记忆数、最近运行记录',
    'status = requests.get(',
    '    f"{BASE_URL}/api/projects/{PROJECT_ID}/memory/dream",',
    '    headers=HEADERS,',
    ').json()',
    'print(status["pendingCount"], len(status["runs"]))',
    '',
    '# 更新设置',
    'requests.patch(',
    '    f"{BASE_URL}/api/projects/{PROJECT_ID}/memory/dream",',
    '    json={"enabled": True, "intervalMinutes": 720},',
    '    headers=HEADERS,',
    ')',
    '',
    '# 手动触发一次（运行中返回 409）',
    'result = requests.post(',
    '    f"{BASE_URL}/api/projects/{PROJECT_ID}/memory/dream/run",',
    '    headers=HEADERS,',
    ').json()',
    'print(result["run"]["inputCount"], result["run"]["insightCount"])',
  ].join('\n');
}
