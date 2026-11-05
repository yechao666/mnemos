import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { AppContext } from '../contracts.ts';
import type { RequestContext } from './context.ts';
import { errors, sendJson } from './respond.ts';

/** 静态资源托管：web/dist 存在时输出文件，未命中且非 /api、/v1 时回退 index.html（SPA）。 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
};

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (relativePath === '/index.html') return 'no-cache';
  return 'public, max-age=3600';
}

function sendFile(rc: RequestContext, filePath: string, relativePath: string): void {
  let size = 0;
  let mtime = new Date();
  try {
    const stat = statSync(filePath);
    size = stat.size;
    mtime = stat.mtime;
  } catch {
    throw errors.notFound('静态资源不存在');
  }

  const res = rc.res;
  res.statusCode = 200;
  res.setHeader('content-type', contentType(filePath));
  res.setHeader('content-length', String(size));
  res.setHeader('cache-control', cacheControlFor(relativePath));
  res.setHeader('last-modified', mtime.toUTCString());
  if (rc.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, rc.requestId, 500, { error: { code: 'INTERNAL_ERROR', message: '静态资源读取失败', requestId: rc.requestId } });
    else res.destroy();
  });
  stream.pipe(res);
}

export async function serveStatic(app: AppContext, rc: RequestContext): Promise<void> {
  const dist = app.env.webDist;
  const distRoot = resolve(dist);

  if (!dist || !existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
    sendJson(rc.res, rc.requestId, 200, {
      ok: false,
      app: 'Mnemos',
      message: '前端静态资源尚未构建，当前仅提供 API 服务。',
      hint: '运行 `pnpm run build` 生成 web/dist 后刷新页面；或使用 `pnpm run dev:web` 启动前端开发服务器。',
      apiHealth: '/api/health',
      webDist: dist,
    });
    return;
  }

  let relative: string;
  try {
    relative = decodeURIComponent(rc.pathname);
  } catch {
    throw errors.badRequest('路径编码不合法');
  }
  if (relative.includes('\0')) throw errors.badRequest('路径不合法');
  if (relative === '/' || relative === '') relative = '/index.html';

  const target = resolve(join(distRoot, relative));
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    throw errors.forbidden('路径越界');
  }

  if (isFile(target)) {
    sendFile(rc, target, relative);
    return;
  }

  const indexPath = join(distRoot, 'index.html');
  if (isFile(indexPath)) {
    sendFile(rc, indexPath, '/index.html');
    return;
  }

  sendJson(rc.res, rc.requestId, 200, {
    ok: false,
    message: '未找到请求的静态资源，且前端入口 index.html 缺失。',
    hint: '请重新构建前端：`pnpm run build`',
    webDist: dist,
  });
}
