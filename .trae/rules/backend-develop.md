# 后端开发规则

遵循简单胜于复杂，扁平胜于嵌套，可读性至关重要。

1. API 放 `server/api/`，遵循 Nuxt 文件路由命名
2. Better Auth 配在 `lib/auth.ts`，已有 `[...all].ts`，不用再建
3. Drizzle ORM + PostgreSQL，schema 在 `lib/schema/`
4. Redis 存会话，减轻数据库负担
5. 生产必须开安全 Cookie，不要关 CSRF/Origin 检查
6. 加插件后要重新生成 schema：`pnpm auth:generate`
7. 提交前跑 `pnpm lint` 和 `pnpm typecheck`
