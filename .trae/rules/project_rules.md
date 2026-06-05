# RSSFed 项目规则

支持 ActivityPub 的 RSS 阅读器，monorepo（pnpm workspace），`packages/app`（Nuxt 前端）+ `packages/server`（Hono 后端）。

## 编码规范

- **语言**：TypeScript 优先
- **命名**：文件名 kebab-case，变量/函数 camelCase，组件/类 PascalCase
- **前端**：Nuxt 4 + Vue 3 Composition API（`<script setup>`）
- **后端**：Hono
- **测试**：Vitest
- **注释**：关键逻辑和复杂处添加中文注释
- **代码组织**：超过 20 行的代码块优先考虑适当抽象或聚合

## 常用命令

```bash
pnpm dev:all        # 并行运行所有子包
pnpm dev:nuxt       # 仅前端
pnpm dev            # 仅服务端
pnpm build          # 构建所有子包
pnpm test           # 运行测试
pnpm typecheck      # 类型检查
pnpm -r run lint    # Lint 检查
pnpm db:push        # Drizzle code-first 推送 schema 到数据库
```
