# RSSFed 项目规则

支持 ActivityPub 的 RSS 阅读器，monorepo（pnpm workspace），`packages/nuxt-client`（Nuxt 前端）+ `packages/hono-server`（Hono 后端）。

## 编码规范

- **语言**：TypeScript 优先
- **命名**：文件名 kebab-case，变量/函数 camelCase，组件/类 PascalCase
- **前端**：Nuxt 4 + Vue 3 Composition API（`<script setup>`）
- **后端**：Hono
- **测试**：Vitest
- **注释**：关键逻辑和复杂处添加中文注释

## UI 规范

- **间距/内边距优先用主题默认值**：Nuxt UI 的 `ui` 覆盖只做合并、不会替换，没必要把主题已有的值
  再手写一遍。
- **确有必要时，按同一套默认值成对改**。例如为了让滚动条贴面板边缘、内边距跟着内容一起滚，
  会把组件默认内边距清零（`p-0 sm:p-0`）再在滚动区补回同样的 `px-4 sm:px-6`——这类改动两侧
  必须成对（含 `sm:` / `lg:` 断点），并在注释里写明它对齐的是哪个默认值。
- **纯 UI 细节不写单元测试**：间距、圆角、配色、渐隐这类改动用 Playwright/截图看效果即可；
  只有交互、状态流转、边界逻辑才补 vitest。

## 文档规范（重要）

**按需读，不要通读 docs/。** 每份文档只负责一类内容：

| 要查什么 | 读哪份 |
| --- | --- |
| 不变量、库职责、部署拓扑、数据流 | `ARCHITECTURE.md`（≤200 行，只写"什么必须成立 / 为什么"） |
| 前端列表、虚拟化、已读收藏交互 | `docs/frontend-list-rendering.md` |
| Service Worker、PWA、图标 | `docs/offline-and-pwa.md` |
| 部署步骤、镜像、反代 | `docs/docker-deployment.md` |
| 现象 → 原因 → 解法 | `docs/troubleshooting.md` |
| 尚未落地的事项 | `docs/cloud-deployment-todo.md` |

写作纪律：

- 架构文档**只写不变量与取舍**，不写实现细节、操作步骤、压测数据、以及"曾经试过 X 不行"——
  那些属于代码注释、`report/` 或 commit message。
- **功能提交不默认附带文档改动**。只有不变量本身变了（新增存储层、改变同步方向、换传输协议）
  才更新 `ARCHITECTURE.md`；每做一个功能就补一段做法会让它单调膨胀。
- 实现细节的归宿是**代码注释**（就近、随文件读入、成本低），文档写取舍与边界。

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
