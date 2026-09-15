import { Hono, type Context, type Next } from "hono"
import { auth } from "../auth"
import { createToken, listTokens, deleteToken } from "../services/api-token"

type TokenVariables = { userId: string }

/** 校验登录态并将 userId 写入 context（未登录 401） */
async function requireAuth(c: Context<{ Variables: TokenVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
}

export const userTokensRouter = new Hono<{ Variables: TokenVariables }>()

/** 生成一个新 API token，明文仅此处返回一次 */
userTokensRouter.post("/", requireAuth, async (c) => {
  const userId = c.get("userId")
  const body = await c.req.json().catch(() => ({}))
  const name = typeof body?.name === "string" ? body.name : undefined
  const expiresInDays = typeof body?.expiresInDays === "number" ? body.expiresInDays : undefined
  const expiresAt = expiresInDays && expiresInDays > 0
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null

  const { token, record } = await createToken(userId, name, expiresAt)
  return c.json({
    token, // 仅此一次，请客户端妥善保存
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }, 201)
})

/** 列出当前用户的 token 元数据（不含明文 / hash） */
userTokensRouter.get("/", requireAuth, async (c) => {
  const userId = c.get("userId")
  const tokens = await listTokens(userId)
  return c.json(tokens.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  })))
})

/** 删除当前用户的某个 token（物理删除，删除后不可恢复） */
userTokensRouter.delete("/:id", requireAuth, async (c) => {
  const userId = c.get("userId")
  const tokenId = c.req.param("id")!
  const ok = await deleteToken(userId, tokenId)
  if (!ok) return c.json({ error: "token not found" }, 404)
  return c.json({ success: true })
})
