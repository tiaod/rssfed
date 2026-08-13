import { Hono, type Context, type Next } from "hono"
import { eq } from "drizzle-orm"
import { db, user } from "../db"
import { auth } from "../auth"
import { ApiError, handleAvatarUpload } from "../avatar"

type UserVariables = { userId: string }

/** 校验登录态并将 userId 写入 context（未登录 401） */
async function requireAuth(c: Context<{ Variables: UserVariables }>, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
}

export const userRouter = new Hono<{ Variables: UserVariables }>()

/** 上传当前用户头像（multipart: file 字段），S3 存储 + attachments 表外键 */
userRouter.post("/avatar", requireAuth, async (c) => {
  const userId = c.get("userId")
  try {
    const attachment = await handleAvatarUpload(c, userId, async (newAttachmentId, url) => {
      // 先读旧外键再更新：RETURNING 返回的是更新后值，不能用来定位旧附件
      const [before] = await db.select({ oldAttachmentId: user.avatarAttachmentId })
        .from(user).where(eq(user.id, userId)).limit(1)
      // image 列保留为冗余展示 URL（Better Auth session 直出），外键定位旧文件
      await db.update(user)
        .set({ image: url, avatarAttachmentId: newAttachmentId })
        .where(eq(user.id, userId))
      return { oldAttachmentId: before?.oldAttachmentId ?? null }
    })
    return c.json({ success: true, avatarUrl: attachment.url })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})
