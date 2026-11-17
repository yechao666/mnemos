#!/usr/bin/env node
/**
 * Mnemos MCP server 入口：stdio + 按行分隔 JSON-RPC。
 *
 * 启动：node src/index.js（或安装后 mnemos-mcp）
 * 日志只走 stderr；stdout 仅输出 JSON-RPC 响应，避免污染协议。
 */

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { MnemosHttpClient } from './client.js';
import { loadConfig } from './config.js';
import { MnemosMcpServer } from './server.js';

function log(message, error) {
  if (error) process.stderr.write(`[mnemos-mcp] ${message} ${error?.stack || error}\n`);
  else process.stderr.write(`[mnemos-mcp] ${message}\n`);
}

export function createServer(env = process.env) {
  const config = loadConfig(env);
  const client = new MnemosHttpClient(config);
  return { config, client, server: new MnemosMcpServer({ client, config }) };
}

export function start() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    log('配置错误', error);
    process.exit(1);
  }

  if (!config.apiKey) log('警告：未设置 MNEMOS_API_KEY，写操作与多数读操作会返回 401');
  if (!config.partition) log('警告：未设置 MNEMOS_PARTITION，除 mnemos_status 外的工具会报错');
  log(`启动：base_url=${config.baseUrl} partition=${config.partition || '(未配置)'} person=${config.person}`);

  const client = new MnemosHttpClient(config);
  const server = new MnemosMcpServer({ client, config });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    // 串行处理，避免同一连接上的响应乱序；单条失败不影响后续。
    queue = queue
      .then(async () => {
        const output = await server.handleLine(line);
        if (output) process.stdout.write(`${output}\n`);
      })
      .catch((error) => {
        log('处理请求失败', error);
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error' },
          })}\n`,
        );
      });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });

  // 最后一道防线：MCP server 不应因单条请求把进程带崩。
  process.on('uncaughtException', (error) => log('uncaughtException', error));
  process.on('unhandledRejection', (error) => log('unhandledRejection', error));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
