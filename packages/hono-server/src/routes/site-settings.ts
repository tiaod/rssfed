import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { db, siteSettings, type SiteSettings } from "../db"
import { requireAdmin } from "../middleware/require-admin"
import { ApiError, handleAvatarUpload, cleanupAttachment } from "../avatar"

type SiteSettingsVariables = { userId: string }

/** 站点配置恒为单行，固定主键 */
const SITE_ID = "site"

/** 保证单例行存在；并发安全（onConflictDoNothing） */
async function ensureSiteSettingsRow() {
  await db.insert(siteSettings).values({ id: SITE_ID }).onConflictDoNothing()
}

export type SiteSettingsUpdate = Partial<
  Pick<SiteSettings, "siteTitle" | "description" | "primaryColor" | "skin">
>

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * 校验并归一化更新负载（仅采纳出现过的字段；null 表示恢复默认）。
 * 非法输入抛 ApiError(422)。
 */
function normalizeUpdate(body: unknown): SiteSettingsUpdate {
  if (typeof body !== "object" || body === null) throw new ApiError(422, "请求体格式错误")
  const src = body as Record<string, unknown>
  const patch: SiteSettingsUpdate = {}

  const { siteTitle, description, primaryColor, skin } = src
  if (siteTitle !== undefined) {
    if (siteTitle === null) patch.siteTitle = null
    else if (typeof siteTitle !== "string" || !siteTitle.trim() || siteTitle.trim().length > 200)
      throw new ApiError(422, "站点标题需为非空字符串，长度不超过 200")
    else patch.siteTitle = siteTitle.trim()
  }
  if (description !== undefined) {
    if (description === null) patch.description = null
    else if (typeof description !== "string" || description.trim().length > 2000)
      throw new ApiError(422, "描述需为字符串，长度不超过 2000")
    else patch.description = description.trim()
  }
  if (primaryColor !== undefined) {
    if (primaryColor === null) patch.primaryColor = null
    else if (typeof primaryColor !== "string" || !HEX_COLOR_RE.test(primaryColor.trim()))
      throw new ApiError(422, "主题色需为 #rgb 或 #rrggbb 格式")
    else patch.primaryColor = primaryColor.trim().toLowerCase()
  }
  if (skin !== undefined) {
    if (skin === null) patch.skin = null
    else if (typeof skin !== "string" || !skin.trim() || skin.trim().length > 64)
      throw new ApiError(422, "皮肤标识需为非空字符串，长度不超过 64")
    else patch.skin = skin.trim()
  }
  return patch
}

/** 序列化为接口 JSON（时间戳转 ISO 字符串，去掉内部字段） */
function serialize(row: SiteSettings) {
  return {
    siteTitle: row.siteTitle,
    description: row.description,
    logoUrl: row.logoUrl,
    primaryColor: row.primaryColor,
    skin: row.skin,
    extras: row.extras,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 公开品牌信息：免登录读取安全子集，供任意页面前端渲染与 Service Worker
 * network-first 缓存（离线时仍能展示站点 logo/主题）。
 */
export const siteSettingsPublicRouter = new Hono()

siteSettingsPublicRouter.get("/", async (c) => {
  const [row] = await db
    .select({ siteTitle: siteSettings.siteTitle, description: siteSettings.description, logoUrl: siteSettings.logoUrl, primaryColor: siteSettings.primaryColor, skin: siteSettings.skin })
    .from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
  return c.json(row ?? {})
})

/** 站点配置管理（仅管理员）：读取、更新品牌字段、上传/删除 logo */
export const siteSettingsAdminRouter = new Hono<{ Variables: SiteSettingsVariables }>()

siteSettingsAdminRouter.get("/", requireAdmin, async (c) => {
  await ensureSiteSettingsRow()
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
  return c.json(row ? serialize(row) : {})
})

siteSettingsAdminRouter.put("/", requireAdmin, async (c) => {
  try {
    const body = await c.req.json()
    const patch = normalizeUpdate(body)
    await ensureSiteSettingsRow()
    const [row] = await db.update(siteSettings).set(patch).where(eq(siteSettings.id, SITE_ID)).returning()
    return c.json(row ? serialize(row) : {})
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

/** 上传站点 logo（multipart: file 字段），S3 存储 + attachments 表外键，复用头像上传流程 */
siteSettingsAdminRouter.post("/logo", requireAdmin, async (c) => {
  try {
    const attachment = await handleAvatarUpload(c, SITE_ID, async (newAttachmentId, url) => {
      // 先读旧外键再写：RETURNING 返回更新后值，不能用来定位旧附件
      const [before] = await db.select({ oldAttachmentId: siteSettings.logoAttachmentId })
        .from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
      if (before) {
        await db.update(siteSettings)
          .set({ logoUrl: url, logoAttachmentId: newAttachmentId })
          .where(eq(siteSettings.id, SITE_ID))
      } else {
        await db.insert(siteSettings).values({ id: SITE_ID, logoUrl: url, logoAttachmentId: newAttachmentId })
      }
      return { oldAttachmentId: before?.oldAttachmentId ?? null }
    })
    return c.json({ success: true, logoUrl: attachment.url })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

/** 删除站点 logo（连同 S3 文件与附件元数据），恢复默认品牌 */
siteSettingsAdminRouter.delete("/logo", requireAdmin, async (c) => {
  try {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
    if (row) {
      await cleanupAttachment(row.logoAttachmentId)
      await db.update(siteSettings)
        .set({ logoUrl: null, logoAttachmentId: null })
        .where(eq(siteSettings.id, SITE_ID))
    }
    return c.json({ success: true })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})
