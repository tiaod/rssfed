import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { eq } from "drizzle-orm"
import { db, attachments, type Attachment } from "./db"
import { storage, getUserFilePath, generateUniqueFileName } from "./storage"

/** 头像大小上限：5MB */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

/** 带 HTTP 状态码的业务错误，供路由层转成对应 JSON 响应 */
export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) {
    super(message)
  }
}

/** 从 multipart 请求体提取并校验头像文件：必须存在、image/*、≤ 5MB */
async function extractAvatarFile(c: Context): Promise<File> {
  const body = await c.req.parseBody()
  const file = body["file"]
  if (!(file instanceof File)) {
    throw new ApiError(400, "缺少 file 字段")
  }
  if (!file.type.startsWith("image/")) {
    throw new ApiError(400, "仅支持图片文件")
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new ApiError(400, "图片大小不能超过 5MB")
  }
  return file
}

/**
 * 删除旧附件：有 S3 key 先删文件（失败仅告警，避免阻塞主流程），再删元数据行。
 * 供上传换头像与删除业务对象时复用，防止孤儿对象。
 */
export async function cleanupAttachment(attachmentId: string | null) {
  if (!attachmentId) return
  const [old] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1)
  if (!old) return
  if (old.storageKey) {
    await storage.delete(old.storageKey).catch(() => {
      console.warn(`[Avatar] S3 删除失败: ${old.storageKey}`)
    })
  }
  await db.delete(attachments).where(eq(attachments.id, attachmentId))
}

/**
 * 附件公开 URL：优先 S3 publicDomain（可挂 CDN / 直接对外），
 * 未配置时回退到本服务的文件代理路由，保证默认开箱即用。
 */
function publicUrlOf(c: Context, key: string): string {
  const fromStorage = storage.getPublicUrl(key)
  if (fromStorage) return fromStorage
  return `${new URL(c.req.url).origin}/api/files/${key}`
}

/**
 * 头像上传通用流程：S3 写文件 → 建 attachments 行 → 更新业务表外键与冗余 URL 列 → 删旧附件。
 * update 回调负责写业务表（bots/user），返回旧外键 id 以定位旧文件。
 * 任一步失败会清理已写入的 S3 文件与新建行，避免孤儿。
 */
export async function handleAvatarUpload(
  c: Context,
  ownerId: string,
  update: (newAttachmentId: string, url: string) => Promise<{ oldAttachmentId: string | null }>,
): Promise<Attachment> {
  const file = await extractAvatarFile(c)
  const key = getUserFilePath(ownerId, generateUniqueFileName(file.name))
  const buffer = Buffer.from(await file.arrayBuffer())
  const url = publicUrlOf(c, key)

  let attachment: Attachment | undefined
  try {
    await storage.write(buffer, key, file.type)
    const [row] = await db.insert(attachments).values({
      id: randomUUID(),
      storageKey: key,
      url,
      mimeType: file.type,
      sizeBytes: buffer.length,
    }).returning()
    if (!row) throw new ApiError(500, "附件记录创建失败")
    attachment = row

    const { oldAttachmentId } = await update(row.id, url)
    await cleanupAttachment(oldAttachmentId)
    return row
  } catch (err) {
    // 失败清理：新附件行（若已建）与已写入的 S3 文件
    if (attachment) {
      try {
        await db.delete(attachments).where(eq(attachments.id, attachment.id))
      } catch { /* 行清理失败不掩盖原始错误 */ }
    }
    try {
      await storage.delete(key)
    } catch { /* 文件清理失败不掩盖原始错误 */ }
    throw err
  }
}
