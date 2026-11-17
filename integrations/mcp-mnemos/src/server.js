/**
 * Mnemos MCP server（stdio JSON-RPC 2.0，按行分隔）。
 *
 * 生命周期方法：initialize、notifications/initialized、ping；
 * 工具：tools/list、tools/call；资源：resources/list、resources/read。
 *
 * 设计约束：
 * - 协议错误返回 JSON-RPC error；工具执行失败返回 `{content, isError:true}`；
 * - 任何 handler 异常都在本层兜底，不向上抛、不导致进程退出；
 * - stdout 只写 JSON-RPC 响应，日志一律走 stderr。
 */

import { MnemosHttpError } from './client.js';
import {
  ToolError,
  findTool,
  listResources,
  listTools,
  readResource,
  toolErrorMessage,
} from './tools.js';

export const SERVER_INFO = { name: 'mnemos-mcp', version: '1.0.0' };
export const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const INSTRUCTIONS = [
  'Mnemos 记忆服务（分区 + 人 + 记忆）。',
  '开始时先用 mnemos_context 取默认人的上下文；需要旧事实用 mnemos_search；新结论用 mnemos_add 沉淀；',
  '人物资料用 mnemos_brief / mnemos_profile；连接问题用 mnemos_status。',
  '分区由 MNEMOS_PARTITION 配置，默认人 MNEMOS_PERSON（默认 dsh-agent）。',
].join('');

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function validateRequired(schema, args) {
  if (!schema || !Array.isArray(schema.required)) return;
  for (const key of schema.required) {
    if (args[key] === undefined || args[key] === null) {
      throw new ToolError(`参数缺失：${key}`);
    }
  }
}

export class MnemosMcpServer {
  /**
   * @param {{ client: { request: Function }, config: Object, logger?: Console }} options
   */
  constructor({ client, config, logger = console }) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

  /** 处理一行输入；返回一行响应或 null（通知/空行）。 */
  async handleLine(line) {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed) return null;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return JSON.stringify(errorResponse(null, -32700, 'Parse error：不是合法 JSON'));
    }
    try {
      const response = await this.handle(message);
      return response ? JSON.stringify(response) : null;
    } catch (error) {
      this.logger?.error?.('[mnemos-mcp] 未处理异常', error);
      const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id : null;
      return JSON.stringify(errorResponse(id, -32603, 'Internal error'));
    }
  }

  /**
   * 处理一条 JSON-RPC 消息。
   * @returns {Promise<Object|null>} JSON-RPC 响应；通知返回 null。
   */
  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, -32600, 'Invalid Request：需要单个 JSON-RPC 对象');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : undefined;
    const isNotification = !hasId;

    if (message.jsonrpc !== '2.0') {
      return errorResponse(id, -32600, 'Invalid Request：jsonrpc 必须为 "2.0"');
    }
    const method = message.method;
    if (typeof method !== 'string' || !method) {
      return errorResponse(id, -32600, 'Invalid Request：method 必须是非空字符串');
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    // 通知：不响应（包括客户端初始化完成、取消请求）。
    if (isNotification) {
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
      this.logger?.error?.(`[mnemos-mcp] 忽略未知通知：${method}`);
      return null;
    }

    switch (method) {
      case 'initialize':
        return resultResponse(id, this.#initialize(params));
      case 'ping':
        return resultResponse(id, {});
      case 'logging/setLevel':
        return resultResponse(id, {});
      case 'tools/list':
        return resultResponse(id, { tools: listTools() });
      case 'tools/call':
        return resultResponse(id, await this.#callTool(params));
      case 'resources/list':
        return resultResponse(id, { resources: listResources(this.config) });
      case 'resources/read':
        return this.#readResource(id, params);
      default:
        return errorResponse(id, -32601, `Method not found：${method}`);
    }
  }

  #initialize(params) {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    };
  }

  async #callTool(params) {
    const name = params.name;
    if (typeof name !== 'string' || !name) {
      return {
        content: [{ type: 'text', text: 'tools/call 需要 params.name' }],
        isError: true,
      };
    }
    const tool = findTool(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `未知工具：${name}` }],
        isError: true,
      };
    }
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    try {
      validateRequired(tool.inputSchema, args);
      const result = await tool.handler(args, { client: this.client, config: this.config });
      if (!result || !Array.isArray(result.content) || result.content.length === 0) {
        return {
          content: [{ type: 'text', text: `${name} 没有返回内容` }],
          isError: true,
        };
      }
      return result;
    } catch (error) {
      return {
        content: [{ type: 'text', text: toolErrorMessage(error) }],
        isError: true,
      };
    }
  }

  async #readResource(id, params) {
    const uri = params.uri;
    if (typeof uri !== 'string' || !uri) {
      return errorResponse(id, -32602, 'resources/read 需要 params.uri');
    }
    try {
      const result = await readResource(uri, { client: this.client, config: this.config });
      return resultResponse(id, result);
    } catch (error) {
      if (error instanceof ToolError) {
        return errorResponse(id, -32002, toolErrorMessage(error), { uri });
      }
      if (error instanceof MnemosHttpError && error.status === 404) {
        return errorResponse(id, -32002, toolErrorMessage(error), { uri });
      }
      this.logger?.error?.('[mnemos-mcp] resources/read 失败', error);
      return errorResponse(id, -32603, toolErrorMessage(error), { uri });
    }
  }
}
