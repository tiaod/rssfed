import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { db, siteSettings, type SiteSettings } from "../db"
import { requireAdmin } from "../middleware/require-admin"
import { ApiError, handleAvatarUpload, cleanupAttachment } from "../avatar"
import {
  DISPLAY_MODES,
  SHORT_NAME_MAX_EXPLICIT,
  buildManifest,
  isIconSpecKey,
  resolvePwaConfig,
  settingsVersion,
  type PwaSettingsRow,
  type ResolvedPwaConfig
} from "../pwa/manifest"
import { getPwaIcon } from "../pwa/icons"
import { etagMatches } from "../pwa/etag"

type SiteSettingsVariables = { userId: string }

/** 站点配置恒为单行，固定主键 */
const SITE_ID = "site"

/** 保证单例行存在；并发安全（onConflictDoNothing） */
async function ensureSiteSettingsRow() {
  await db.insert(siteSettings).values({ id: SITE_ID }).onConflictDoNothing()
}

export type SiteSettingsUpdate = Partial<
  Pick<
    SiteSettings,
    "siteTitle" | "description" | "primaryColor" | "skin"
    | "pwaShortName" | "pwaDisplay" | "pwaThemeColor" | "pwaBackgroundColor"
  >
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

  // ── PWA 字段（校验规则与 pwa/manifest.ts 的读取期回退一致） ──────────────
  const { pwaShortName, pwaDisplay, pwaThemeColor, pwaBackgroundColor } = src
  if (pwaShortName !== undefined) {
    if (pwaShortName === null) patch.pwaShortName = null
    else if (typeof pwaShortName !== "string"
      || !pwaShortName.trim()
      || pwaShortName.trim().length > SHORT_NAME_MAX_EXPLICIT)
      throw new ApiError(422, `主屏幕短名需为非空字符串，长度不超过 ${SHORT_NAME_MAX_EXPLICIT}`)
    else patch.pwaShortName = pwaShortName.trim()
  }
  if (pwaDisplay !== undefined) {
    if (pwaDisplay === null) patch.pwaDisplay = null
    else if (typeof pwaDisplay !== "string"
      || !(DISPLAY_MODES as readonly string[]).includes(pwaDisplay.trim()))
      throw new ApiError(422, `显示模式需为 ${DISPLAY_MODES.join(" | ")} 之一`)
    else patch.pwaDisplay = pwaDisplay.trim()
  }
  // 两个颜色字段规则相同：hex，null 恢复默认
  for (const [key, label] of [
    ["pwaThemeColor", "PWA 主题色"],
    ["pwaBackgroundColor", "PWA 背景色"]
  ] as const) {
    const value = src[key]
    if (value === undefined) continue
    if (value === null) patch[key] = null
    else if (typeof value !== "string" || !HEX_COLOR_RE.test(value.trim()))
      throw new ApiError(422, `${label}需为 #rgb 或 #rrggbb 格式`)
    else patch[key] = value.trim().toLowerCase()
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
    pwaShortName: row.pwaShortName,
    pwaDisplay: row.pwaDisplay,
    pwaThemeColor: row.pwaThemeColor,
    pwaBackgroundColor: row.pwaBackgroundColor,
    pwaIconUrl: row.pwaIconUrl,
    extras: row.extras,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 公开品牌信息：免登录读取安全子集，供任意页面前端渲染与 Service Worker
 * network-first 缓存（离线时仍能展示站点 logo/主题）。
 *
 * 同时承载动态 Web App Manifest 与 PWA 图标：路径都在 /api/site-settings 下，
 * 既免登录，又落在反代既有的 /api/* 规则内（无需为 /manifest.webmanifest 单独放行）。
 */
export const siteSettingsPublicRouter = new Hono()

siteSettingsPublicRouter.get("/", async (c) => {
  const [row] = await db
    .select({
      siteTitle: siteSettings.siteTitle,
      description: siteSettings.description,
      logoUrl: siteSettings.logoUrl,
      primaryColor: siteSettings.primaryColor,
      skin: siteSettings.skin,
      pwaShortName: siteSettings.pwaShortName,
      pwaDisplay: siteSettings.pwaDisplay,
      pwaThemeColor: siteSettings.pwaThemeColor,
      pwaBackgroundColor: siteSettings.pwaBackgroundColor,
      pwaIconUrl: siteSettings.pwaIconUrl,
    })
    .from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
  return c.json(row ?? {})
})

/** 配置行尚不存在（管理员从未保存过）时的空值兜底：全部走内置默认 */
const EMPTY_PWA_ROW: PwaSettingsRow = {
  siteTitle: null,
  description: null,
  primaryColor: null,
  pwaShortName: null,
  pwaDisplay: null,
  pwaThemeColor: null,
  pwaBackgroundColor: null,
  pwaIconUrl: null,
  pwaIconAttachmentId: null,
  logoUrl: null,
  logoAttachmentId: null,
  updatedAt: new Date(0)
}

/** 读取渲染 PWA 所需的整行配置（含不外发的附件外键与更新时间） */
async function loadPwaRow(): Promise<PwaSettingsRow> {
  const [row] = await db
    .select({
      siteTitle: siteSettings.siteTitle,
      description: siteSettings.description,
      primaryColor: siteSettings.primaryColor,
      pwaShortName: siteSettings.pwaShortName,
      pwaDisplay: siteSettings.pwaDisplay,
      pwaThemeColor: siteSettings.pwaThemeColor,
      pwaBackgroundColor: siteSettings.pwaBackgroundColor,
      pwaIconUrl: siteSettings.pwaIconUrl,
      pwaIconAttachmentId: siteSettings.pwaIconAttachmentId,
      logoUrl: siteSettings.logoUrl,
      logoAttachmentId: siteSettings.logoAttachmentId,
      updatedAt: siteSettings.updatedAt
    })
    .from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
  return row ?? EMPTY_PWA_ROW
}

/**
 * 动态 Web App Manifest：`<link rel="manifest">` 指向的固定 URL，内容按站点配置渲染。
 *
 * `Cache-Control: no-cache` + ETag：manifest 体积极小，让浏览器每次带 If-None-Match
 * 回来验证，管理员改完配置立即生效，不必等缓存过期。
 */
siteSettingsPublicRouter.get("/manifest.webmanifest", async (c) => {
  const row = await loadPwaRow()
  const config: ResolvedPwaConfig = resolvePwaConfig(row)
  const manifest = buildManifest(config)
  const etag = `W/"${config.version}"`

  // 304 也要回带 ETag：客户端据此把缓存条目续上，否则下次又变成无条件请求
  if (etagMatches(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { "Cache-Control": "no-cache", "ETag": etag })
  }

  return c.body(JSON.stringify(manifest), 200, {
    "Content-Type": "application/manifest+json; charset=utf-8",
    "Cache-Control": "no-cache",
    "ETag": etag
  })
})

/**
 * PWA 图标：按规格实时渲染 PNG，实际输出像素由 ICON_SPECS 决定（与 manifest 的
 * sizes 同源，避免「声明 512 实际输出别的尺寸」导致浏览器丢弃图标）。
 *
 * 带 `?v=` 的是 manifest 里下发的版本化 URL，内容与版本严格对应，可 immutable 长缓存；
 * 不带 v 的（手工访问、旧链接）只短缓存，配置变更后不至于长期陈旧。
 *
 * ETag 用「配置版本 + 规格」，并在渲染之前先做条件请求判断：命中就直接 304，
 * 至少省掉一次 sharp 解码/渲染（缓存未命中时这一跳并不便宜）。
 */
siteSettingsPublicRouter.get("/icon/:spec", async (c) => {
  const spec = c.req.param("spec").replace(/\.png$/i, "")
  if (!isIconSpecKey(spec)) return c.json({ error: "未知的图标规格" }, 404)

  const row = await loadPwaRow()
  const etag = `W/"${settingsVersion(row)}-${spec}"`
  const cacheControl = c.req.query("v") !== undefined
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300"

  if (etagMatches(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { "Cache-Control": cacheControl, "ETag": etag })
  }

  const png = await getPwaIcon(row, spec)

  return c.body(new Uint8Array(png), 200, {
    "Content-Type": "image/png",
    "Cache-Control": cacheControl,
    "ETag": etag
  })
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

/**
 * 上传 PWA 方形图标（multipart: file 字段）。
 * 与站点 logo 分开：logo 多为横版（站点页头用），直接裁方会变形或切字，
 * 故 PWA 图标允许单独上传一张方图；留空则回退到用 logo 裁剪。
 */
siteSettingsAdminRouter.post("/icon", requireAdmin, async (c) => {
  try {
    const attachment = await handleAvatarUpload(c, SITE_ID, async (newAttachmentId, url) => {
      // 先读旧外键再写：RETURNING 返回更新后值，不能用来定位旧附件
      const [before] = await db.select({ oldAttachmentId: siteSettings.pwaIconAttachmentId })
        .from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
      if (before) {
        await db.update(siteSettings)
          .set({ pwaIconUrl: url, pwaIconAttachmentId: newAttachmentId })
          .where(eq(siteSettings.id, SITE_ID))
      } else {
        await db.insert(siteSettings).values({ id: SITE_ID, pwaIconUrl: url, pwaIconAttachmentId: newAttachmentId })
      }
      return { oldAttachmentId: before?.oldAttachmentId ?? null }
    })
    return c.json({ success: true, pwaIconUrl: attachment.url })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})

/** 删除 PWA 图标（连同 S3 文件与附件元数据），图标回退到「logo 裁剪 → 内置默认」 */
siteSettingsAdminRouter.delete("/icon", requireAdmin, async (c) => {
  try {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, SITE_ID)).limit(1)
    if (row) {
      await cleanupAttachment(row.pwaIconAttachmentId)
      await db.update(siteSettings)
        .set({ pwaIconUrl: null, pwaIconAttachmentId: null })
        .where(eq(siteSettings.id, SITE_ID))
    }
    return c.json({ success: true })
  } catch (err) {
    if (err instanceof ApiError) return c.json({ error: err.message }, err.status)
    throw err
  }
})
