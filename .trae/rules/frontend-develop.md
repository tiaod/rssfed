# 前端开发规则

遵循简单胜于复杂，扁平胜于嵌套，可读性至关重要。

1. 优先用 Nuxt UI 组件，非必要不自定义
2. 使用 Composition API + `<script setup lang="ts">`，不用 Options API
3. SFC 顺序：`<script setup>` → `<template>` → `<style>`
4. 用 Nuxt 自动导入，不用手动写 import
5. Tailwind CSS + Nuxt UI 语义类，别直接写原始色值
6. 图标用 Iconify，格式 `i-{collection}-{name}`，优先 lucide
7. 自定义 Nuxt UI：`ui`/`class` > 全局配置
8. `ref`/`reactive` 存源数据，`computed` 派生，保持最小
9. Props 下，events 上，都要有 TypeScript 类型
10. 复用逻辑抽去 `composables/`，命名 `use<Feature>.ts`
11. 按功能组织组件到 `components/<feature>/`，别堆根目录
12. 使用 pnpm 包管理器
13. 遵循 ESLint：`1tbs` 花括号，不使用拖尾逗号
14. 避免过早优化，功能完成再优化
15. 提交前跑 `pnpm lint` 和 `pnpm typecheck`
