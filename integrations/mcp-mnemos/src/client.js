/**
 * 极简 Mnemos HTTP 客户端（Node 全局 fetch，零依赖）。
 *
 * 只覆盖 MCP server 需要的 `/v1` 与 `/health`；错误统一成
 * `MnemosHttpError`（HTTP 非 2xx）或 `MnemosNetworkError`（连接/超时），
 * 由上层转成 MCP 的 isError 内容，不抛出到进程。
 */

export const USER_AGENT = 'mnemos-mcp/1.0.0';

export class MnemosHttpError extends Error {
  /**
   * @param {number | null} status
   * @param {string} code
   * @param {string} message
   * @param {{ requestId?: string | null, details?: unknown, payload?: unknown }} [options]
   */
  constructor(status, code, message, options = {}) {
    super(message || code);
    this.name = 'MnemosHttpError';
    this.status = status;
    this.code = code || 'HTTP_ERROR';
    this.requestId = options.requestId ?? null;
    this.details = options.details;
    this.payload = options.payload;
  }
}

export class MnemosNetworkError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MnemosNetworkError';
    this.cause = options.cause;
  }
}

/** 去掉 undefined/null，保留 false/0/""。 */
export function compact(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** 路径段编码。 */
export function seg(value) {
  return encodeURIComponent(String(value));
}

export function partitionPath(partition) {
  return `/v1/partitions/${seg(partition)}`;
}

export function personPath(partition, person) {
  return `${partitionPath(partition)}/persons/${seg(person)}`;
}

/** 构造查询串（布尔转 true/false，数组重复 key）。 */
export function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) params.append(key, String(item));
      }
    } else if (typeof value === 'boolean') {
      params.append(key, value ? 'true' : 'false');
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class MnemosHttpClient {
  /**
   * @param {{ baseUrl: string, apiKey?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
   */
  constructor({ baseUrl, apiKey = '', timeoutMs = 30_000, fetchImpl }) {
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      throw new Error(`MNEMOS_BASE_URL 必须是 http(s) 地址：${baseUrl}`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前 Node 没有全局 fetch（需要 Node >= 18.17）');
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, unknown>, body?: Record<string, unknown> | unknown[], auth?: boolean, headers?: Record<string, string> }} [options]
   * @returns {Promise<any>}
   */
  async request(method, path, options = {}) {
    const { query, body, auth = true, headers: extraHeaders } = options;
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;
    const headers = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(extraHeaders || {}),
    };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(compact(body));
    }
    if (auth && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: method.toUpperCase(),
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new MnemosNetworkError(`请求超时（${this.timeoutMs}ms）：${method} ${url}`, { cause: error });
      }
      throw new MnemosNetworkError(`无法连接 Mnemos（${method} ${url}）：${error?.message || error}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 1000) };
      }
    }

    if (!response.ok) {
      const errorBody = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : parsed || {};
      const code = typeof errorBody?.code === 'string' ? errorBody.code : `HTTP_${response.status}`;
      const message = typeof errorBody?.message === 'string' ? errorBody.message : response.statusText;
      throw new MnemosHttpError(response.status, code, message || code, {
        requestId: errorBody?.requestId || response.headers.get('x-request-id'),
        details: errorBody?.details,
        payload: parsed,
      });
    }

    if (response.status === 204 || !text) return null;
    return parsed;
  }

  get(path, options = {}) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }

  patch(path, body, options = {}) {
    return this.request('PATCH', path, { ...options, body });
  }

  delete(path, options = {}) {
    return this.request('DELETE', path, options);
  }

  health() {
    return this.request('GET', '/health', { auth: false });
  }
}
