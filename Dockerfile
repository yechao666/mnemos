# syntax=docker/dockerfile:1
# =============================================================================
# Mnemos 生产镜像
# -----------------------------------------------------------------------------
# 多阶段构建：
#   base      安装 pnpm（corepack 固定 10.4.0）
#   deps      全量依赖（类型检查/测试/构建用）
#   build     生成 web/dist
#   prod-deps 仅生产依赖（运行时 node_modules）
#   runtime   非 root、只带运行所需文件
#
# 注意：本机没有 Docker，镜像未经真实构建验证；CI 中的 docker job 仅做
#       `docker build` 语法/依赖验证（见 docs/production-readiness.md）。
#       容器内运行 + HEALTHCHECK 需在有 Docker 的环境做一次真机验证。
# =============================================================================

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# node:24 仍自带 corepack；固定 pnpm 版本与 packageManager 一致。
RUN corepack enable && corepack prepare pnpm@10.4.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

FROM base AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    MNEMOS_HOST=0.0.0.0 \
    MNEMOS_PORT=4380 \
    MNEMOS_DATA_DIR=/app/data \
    MNEMOS_BACKUP_DIR=/app/data/backups \
    MNEMOS_DEMO=0 \
    MNEMOS_LOG_FORMAT=json \
    MNEMOS_METRICS_ENABLED=1
WORKDIR /app

# 运行所需：根 package.json、生产依赖、server（含原生 TS 源码）、shared、web/dist。
# server/node_modules 中的 zod 符号链接指向根 node_modules/.pnpm，两者必须一起复制。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/src ./server/src
COPY --from=build --chown=node:node /app/shared/src ./shared/src
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/web/dist ./web/dist

# 数据目录归 node 用户；命名卷初始化时会继承该属主。
RUN mkdir -p /app/data/backups && chown -R node:node /app/data

VOLUME ["/app/data"]
EXPOSE 4380
USER node
STOPSIGNAL SIGTERM

# 优先探测 /readyz（就绪探针），未上线时回退 /api/health。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "(async()=>{const base='http://127.0.0.1:'+(process.env.MNEMOS_PORT||4380);let res=await fetch(base+'/readyz');if(res.status===404)res=await fetch(base+'/api/health');process.exit(res.ok?0:1)})().catch(()=>process.exit(1))"

CMD ["node", "server/src/main.ts"]
