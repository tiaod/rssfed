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

  const { user } = event.context

  if (!user) {
    throw createError({ statusCode: 401, message: '需要登录' })
  }

  // 查询文件记录
  const [fileRecord] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))

  if (!fileRecord) {
    throw createError({ statusCode: 404, message: '文件不存在' })
  }

  // 权限检查：只有所有者可以删除
  if (fileRecord.uploadedBy !== user.id) {
    throw createError({ statusCode: 403, message: '无权限删除此文件' })
  }

  // 从存储删除文件
  try {
    if (fileRecord.path) {
      await storage.delete(fileRecord.path)
    }
  } catch (err) {
    console.error('删除文件失败:', err)
    // 即使存储删除失败，也要删除数据库记录
  }

  // 从数据库删除记录
  await db.delete(files).where(eq(files.id, fileId))

  return { success: true }
})
