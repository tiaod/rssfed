import { createError } from 'h3'
import { db } from '~/lib/db'
import { files } from '~/lib/schema/files'
import { storage, generateUniqueFileName, getUserFilePath } from '~/lib/storage'
import { auth } from '~/lib/auth'

export default defineEventHandler(async (event) => {
  // 验证用户登录
  const session = await auth.api.getSession({
    headers: event.headers
  })

  if (!session) {
    throw createError({ statusCode: 401, message: '需要登录才能上传' })
  }

  // 解析 multipart/form-data
  const formData = await readMultipartFormData(event)
  if (!formData) {
    throw createError({ statusCode: 400, message: '没有找到文件' })
  }

  const fileField = formData.find(f => f.name === 'file')
  if (!fileField || !fileField.data || !fileField.filename) {
    throw createError({ statusCode: 400, message: '文件信息不完整' })
  }

  // 获取可选的标题标签
  const titleField = formData.find(f => f.name === 'title')
  const title = titleField?.data?.toString('utf-8')

  // 生成文件名和存储路径
  const uniqueFilename = generateUniqueFileName(fileField.filename)
  const storagePath = getUserFilePath(session.user.id, uniqueFilename)
  const contentType = fileField.type || 'application/octet-stream'

  // 存储文件到适配器
  await storage.write(fileField.data, storagePath, contentType)

  // 保存元数据到数据库
  const fileRecords = await db.insert(files).values({
    id: crypto.randomUUID(),
    storage: process.env.STORAGE_DRIVER || 'local',
    filenameDisk: uniqueFilename,
    filenameDownload: fileField.filename,
    type: contentType,
    size: fileField.data.length,
    title: title || null,
    isPublic: false,
    uploadedBy: session.user.id,
    path: storagePath
  }).returning()

  const fileRecord = fileRecords[0]
  if (!fileRecord) {
    throw createError({ statusCode: 500, message: '保存文件记录失败' })
  }

  // 返回信息
  const publicUrl = storage.getPublicUrl(storagePath)

  return {
    success: true,
    file: {
      id: fileRecord.id,
      filename: fileRecord.filenameDownload,
      size: fileRecord.size,
      type: fileRecord.type,
      url: publicUrl,
      createdAt: fileRecord.createdAt
    }
  }
})
