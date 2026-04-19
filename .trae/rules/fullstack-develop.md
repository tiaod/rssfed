# 全栈开发规则

遵循简单胜于复杂，扁平胜于嵌套，可读性至关重要。

## 通用
- 优先使用 **es-toolkit** 工具函数，从对应子路径导入：`import { pick } from 'es-toolkit/object'`
- **测试驱动开发**：新增功能先写测试，再写实现
- 测试放对应目录 `__tests__/`，命名 `*.test.ts`
- 使用 pnpm，遵循 ESLint `1tbs` 风格，不使用拖尾逗号
- 提交前跑 `pnpm lint`、`pnpm typecheck`、`pnpm test:run`
- 避免过早优化，功能完成再优化

## 后端
- API 放 `server/api/`，遵循 Nuxt 文件路由命名
- Better Auth 配在 `lib/auth.ts`，已有 `[...all].ts` 不用新建
- Drizzle ORM + PostgreSQL，schema 在 `lib/schema/`，`pnpm db:push` 同步
- Redis 存会话，生产开安全 Cookie，不要关 CSRF/Origin 检查
- 加插件后重新生成：`pnpm auth:generate`
- 使用 Nuxt 别名 `~`/`~~`，遵循默认配置

## 前端
- 优先 Nuxt UI 组件，非必要不自定义
- Composition API + `<script setup lang="ts">`，不用 Options API
- SFC 顺序：`<script setup>` → `<template>` → `<style>`
- 用 Nuxt 自动导入，不用手动写 import
- Tailwind CSS + Nuxt UI 语义类，不直接写原始色值
- 图标：`i-{collection}-{name}`，优先 lucide
- `ref`/`reactive` 存源，`computed` 派生，保持最小
- Props 向下，events 向上，都要有 TypeScript 类型
- 复用逻辑抽 `composables/use<Feature>.ts`
- 组件按功能放 `components/<feature>/`，不堆根目录
