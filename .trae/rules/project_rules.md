# RSSFed 项目规则
支持 ActivityPub 的 RSS 阅读器，monorepo（pnpm workspace），`packages/nuxt-client`（Nuxt 前端）+ `packages/hono-server`（Hono 后端）。

## 编码规范

- **语言**：TypeScript 优先
- **命名**：文件名 kebab-case，变量/函数 camelCase，组件/类 PascalCase
- **前端**：Nuxt 4 + Vue 3 Composition API（`<script setup>`）
- **后端**：Hono
- **测试**：Vitest
- **注释**：关键逻辑和复杂处添加中文注释

