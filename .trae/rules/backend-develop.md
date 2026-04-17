# 后端开发规则

遵循简单胜于复杂，扁平胜于嵌套，可读性至关重要。

1. API 放 `server/api/`，遵循 Nuxt 文件路由命名
2. Better Auth 配在 `lib/auth.ts`，已有 `[...all].ts`，不用再建
3. Drizzle ORM + PostgreSQL，schema 在 `lib/schema/`，采用 Code First，使用 `pnpm db:push` 同步到数据库
4. Redis 存会话，减轻数据库负担
5. 生产必须开安全 Cookie，不要关 CSRF/Origin 检查
6. 加插件后要重新生成 schema：`pnpm auth:generate`
7. 使用 Nuxt 别名 `~`（`/<rootDir>/app`）、`~~`（`/<rootDir>`）引入模块，遵循默认别名配置
8. 使用文档建议的用法和 API，避免hacky的实现
9. **测试驱动开发**：新增功能先写测试，再写实现，遵循红→绿→重构循环
10. 测试文件放在对应目录 `__tests__/`，命名 `*.test.ts`
11. 工具函数、业务逻辑必须有单元测试，API 优先写集成测试
12. 提交前跑 `pnpm lint`、`pnpm typecheck` 和 `pnpm test:run`
