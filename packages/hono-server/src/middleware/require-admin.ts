import type { Context, Next } from "hono"
import { auth } from "../auth"

/** 认证中间件写入 context 的变量 */
export type AuthVariables = { userId: string }

/**
 * 校验管理员权限：未登录 401 / 非管理员 403，通过后把 userId 写入 context。
 *
 * 站点配置、订阅源管理、BullBoard 队列看板共用这一份实现——看板曾是裸路由，
 * 各路由各自实现鉴权时最容易漏掉的就是这种「非业务接口」。
 */
export async function requireAdmin(c: Context<{ Variables: AuthVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  if (session.user.role !== "admin") return c.json({ error: "forbidden" }, 403)
  c.set("userId", session.user.id)
  await next()
}
