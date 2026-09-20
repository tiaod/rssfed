# RSSFed 项目规则

支持 ActivityPub 的 RSS 阅读器，monorepo（pnpm workspace），`packages/nuxt-client`（Nuxt 前端）+ `packages/hono-server`（Hono 后端）。

## 编码规范

- **语言**：TypeScript 优先
- **命名**：文件名 kebab-case，变量/函数 camelCase，组件/类 PascalCase
- **前端**：Nuxt 4 + Vue 3 Composition API（`<script setup>`）
- **后端**：Hono
- **测试**：Vitest
- **注释**：关键逻辑和复杂处添加中文注释

## 技术栈（架构细节见 ARCHITECTURE.md）

- 认证：Better Auth；关系库：PostgreSQL + Drizzle ORM；文档库：CouchDB 3.x
- 客户端离线：PouchDB（浏览器 IndexedDB 同步）；任务队列：BullMQ（Redis）
- RSS 解析：feedsmith；ActivityPub：BotKit（基于 Fedify）
- 前端 UI：Nuxt UI

## 常用命令

- `pnpm dev:all`：并行运行所有子包（前端 + 后端）
- `pnpm dev:nuxt`：仅运行前端 Nuxt 应用（默认 :3000）
- `pnpm dev`：仅运行后端 Hono 服务
- `pnpm test` / `pnpm typecheck`：运行测试 / 类型检查
- `pnpm db:push`：推送 Drizzle schema 变更到数据库
