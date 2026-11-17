import type { ApiScope, Role } from '../../../shared/src/types.ts';
import type { RequestContext } from './context.ts';

/**
 * 极简路由器：路径分段匹配，支持 `:param` 占位。
 * 不依赖任何第三方框架，满足控制台 / 公开 API 的静态路由需求。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RouteMeta {
  /** none = 公开；console = 会话令牌；apikey = 公开 v1 API Key */
  auth: 'none' | 'console' | 'apikey';
  /** 路径中的项目参数名（默认 id）与所需最低项目角色 */
  project?: { param?: string; minRole?: Role };
  /** apikey 路由所需 scope（全部满足） */
  scopes?: ApiScope[];
  /**
   * 允许组织级 API Key（kind=org）访问。默认 false：org key 只能走 `/v1/partitions/*`
   * 这类自身带分区参数、由 handler 解析分区的端点，避免隐式落到 key 的锚点分区。
   */
  allowOrgKey?: boolean;
  /** 用量记录：业务操作名 */
  operation?: string;
  /** 用量记录：渠道 */
  channel?: 'console' | 'api' | 'playground' | 'system';
  /** 允许从 ?token= 读取会话令牌（SSE 专用） */
  allowQueryToken?: boolean;
}

export interface RouteDefinition extends RouteMeta {
  method: HttpMethod;
  path: string;
  handler: (rc: RequestContext) => void | Promise<void>;
}

interface CompiledRoute extends RouteDefinition {
  segments: string[];
}

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
}

const METHOD_MISMATCH = 'METHOD_MISMATCH';
export type MatchResult = RouteMatch | typeof METHOD_MISMATCH | null;

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** 规范化请求路径：去除尾部斜杠（根路径除外）。 */
export function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  let value = pathname;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value.length === 0 ? '/' : value;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(definition: RouteDefinition): this {
    this.routes.push({ ...definition, segments: splitPath(definition.path) });
    return this;
  }

  addAll(definitions: RouteDefinition[]): this {
    for (const definition of definitions) this.add(definition);
    return this;
  }

  /** 返回匹配结果；路径匹配但方法不符时返回 'METHOD_MISMATCH'。 */
  match(method: string, pathname: string): MatchResult {
    const parts = splitPath(pathname);
    let pathMatched = false;

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index] ?? '';
        const part = parts[index] ?? '';
        if (segment.startsWith(':')) {
          if (part.length === 0) {
            matched = false;
            break;
          }
          params[segment.slice(1)] = safeDecode(part);
        } else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathMatched = true;
      const methodMatches = route.method === method || (method === 'HEAD' && route.method === 'GET');
      if (methodMatches) return { route, params };
    }

    return pathMatched ? METHOD_MISMATCH : null;
  }

  get size(): number {
    return this.routes.length;
  }
}
