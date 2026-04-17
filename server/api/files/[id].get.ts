import { createError } from 'h3'
import { db } from '~/lib/db'
import { files } from '~/lib/schema/files'
import { storage } from '~/lib/storage'
import { eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  const fileId = getRouterParam(event, 'id')
  if (!fileId) {
    throw createError({ statusCode: 400, message: '缺少文件 ID' })
  }

  // 查询数据库记录
  const [fileRecord] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))

  if (!fileRecord) {
    throw createError({ statusCode: 404, message: '文件不存在' })
  }

  // 权限检查：只有公开文件或文件所有者可以访问
  const { user } = event.context

  if (!fileRecord.isPublic && (!user || user.id !== fileRecord.uploadedBy)) {
    throw createError({ statusCode: 403, message: '无权限访问此文件' })
  }

  // 如果存储适配器已经提供了公开 URL，直接 302 跳转
  const directUrl = storage.getPublicUrl(fileRecord.path!)
  if (directUrl) {
    return sendRedirect(event, directUrl)
  }

  // 否则读取文件内容并返回
  const content = await storage.read(fileRecord.path!)

  // 设置响应头
  event.headers.set('Content-Type', fileRecord.type!)
  event.headers.set('Content-Length', String(fileRecord.size))
  const filename = fileRecord.filenameDownload || 'file'
  const contentDisposition = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
  event.headers.set('Content-Disposition', contentDisposition)

  return content
})
