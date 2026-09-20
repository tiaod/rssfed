# syntax=docker/dockerfile:1.7
#
# RSSFed 生产镜像（单 Dockerfile、多 target）
#
#   server  → Hono 后端：API + ActivityPub(BotKit) + BullMQ worker
#   web     → Nuxt 4 前端：Nitro node-server（SSR）
#   migrate → 一次性任务：drizzle-kit push 对齐数据库结构
#
# 单独构建：
#   docker build --target server -t rssfed-server:latest .
#   docker build --target web    -t rssfed-web:latest    .
# 整套部署（推荐）：
#   docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

ARG NODE_VERSION=22
# 与 packages/nuxt-client/package.json 的 packageManager 保持一致
ARG PNPM_VERSION=10.32.1

# ── 公共基础层：Node + pnpm ──────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    CI=true \
    npm_config_store_dir=/pnpm/store
ENV PATH=${PNPM_HOME}:${PATH}
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# ── 全量依赖（含 devDependencies，供两个应用构建）───────────────────────────
FROM base AS deps
# 先只拷贝清单文件：只要 lockfile 不变，这一层就能命中缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY packages/hono-server/package.json packages/hono-server/
COPY packages/nuxt-client/package.json packages/nuxt-client/
# --ignore-scripts：nuxt-client 的 postinstall（nuxt prepare）依赖源码，留到构建阶段执行
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ── 构建阶段 ────────────────────────────────────────────────────────────────
FROM deps AS builder
# Nuxt 构建吃内存，按构建机规格调整（过小会 OOM，过大无益）
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY . .
# 后端：esbuild 打成单文件。源码里的相对导入没有扩展名（tsconfig moduleResolution=bundler），
#       tsc 产物无法被 Node ESM 直接执行，打包后由 esbuild 解析再内联，问题消失。
#       依赖保持 external（--packages=external），运行时仍走 node_modules。
# 前端：nuxt build → .output（自包含，运行镜像无需 node_modules）
RUN pnpm --filter @rssfed/hono-server build:bundle \
 && pnpm --filter @rssfed/nuxt-client build

# ── 数据库迁移（需要 devDependency drizzle-kit 与 schema 源码）──────────────
FROM builder AS migrate
ENV NODE_ENV=production
WORKDIR /app/packages/hono-server
# --force：自动接受数据丢失语句。CI/编排里没有 TTY，不加会卡在交互确认。
# 注意：该参数语义是"自动批准"，可能 truncate 表；首次部署表为空无风险，
#       后续变更请先本地 `pnpm --filter @rssfed/hono-server exec drizzle-kit push --verbose` 复核。
CMD ["pnpm", "exec", "drizzle-kit", "push", "--force"]

# ── 后端运行时依赖：仅 production，且只装 hono-server 一个包 ────────────────
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY packages/hono-server/package.json packages/hono-server/
COPY packages/nuxt-client/package.json packages/nuxt-client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter @rssfed/hono-server

# ── 后端运行镜像 ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS server
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
# 本地文件存储（STORAGE_DRIVER=fs）的挂载点：先建好并 chown，
# 命名卷首次挂载会继承这里的属主与权限，node 用户才写得进去
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
# .npmrc 里 shamefully-hoist=true：依赖实体在根 node_modules/.pnpm，
# 包内 node_modules 只是相对符号链接，两处都要拷且保持层级一致
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/hono-server/node_modules ./packages/hono-server/node_modules
COPY --from=builder   --chown=node:node /app/packages/hono-server/dist ./packages/hono-server/dist
# package.json 必须保留：Node 依赖它把 dist/*.js 识别为 ESM（type: module）
COPY --from=builder   --chown=node:node /app/packages/hono-server/package.json ./packages/hono-server/package.json
WORKDIR /app/packages/hono-server
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||3001}/api/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ── 前端运行镜像 ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS web
ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app/packages/nuxt-client/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.NITRO_PORT||3000}/`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
