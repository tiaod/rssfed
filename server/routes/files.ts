import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db } from '~server/lib/db'
import { files } from '~/lib/schema/files'
import { storage, generateUniqueFileName, getUserFilePath } from '~/lib/storage'
import { eq } from 'drizzle-orm'
import { requireAuth, getOptionalUser } from './_auth'

const app = new Hono()

app.post('/upload', async (c) => {
  const user = requireAuth(c)

  const formData = await c.req.formData()
  const fileField = formData.get('file')
  if (!fileField || !(fileField instanceof File)) {
    throw new HTTPException(400, { message: '没有找到文件' })
  }

  const title = formData.get('title')?.toString()
  const fileBuffer = Buffer.from(await fileField.arrayBuffer())
  const uniqueFilename = generateUniqueFileName(fileField.name)
  const suggestedPath = getUserFilePath(user.id, uniqueFilename)
  const contentType = fileField.type || 'application/octet-stream'

  const actualPath = await storage.write(fileBuffer, suggestedPath, contentType)

  const fileRecords = await db.insert(files).values({
    id: crypto.randomUUID(),
    storage: process.env.STORAGE_DRIVER || 'local',
    filenameDisk: uniqueFilename,
    filenameDownload: fileField.name,
    type: contentType,
    size: fileBuffer.length,
    title: title || null,
    isPublic: false,
    uploadedBy: user.id,
    path: actualPath
  }).returning()

  const fileRecord = fileRecords[0]
  if (!fileRecord) {
    throw new HTTPException(500, { message: '保存文件记录失败' })
  }

  const publicUrl = storage.getPublicUrl(actualPath)
  return c.json({
    success: true,
    file: {
      id: fileRecord.id,
      filename: fileRecord.filenameDownload,
      size: fileRecord.size,
      type: fileRecord.type,
      url: publicUrl,
      createdAt: fileRecord.createdAt
    }
  })
})

// 文件下载
app.get('/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  if (!fileId) {
    throw new HTTPException(400, { message: '缺少文件 ID' })
  }

  const [fileRecord] = await db.select().from(files).where(eq(files.id, fileId))
  if (!fileRecord) {
    throw new HTTPException(404, { message: '文件不存在' })
  }

  const user = getOptionalUser(c)
  if (!fileRecord.isPublic && (!user || user.id !== fileRecord.uploadedBy)) {
    throw new HTTPException(403, { message: '无权限访问此文件' })
  }

  const directUrl = storage.getPublicUrl(fileRecord.path!)
  if (directUrl) {
    return c.redirect(directUrl)
  }

  const content = await storage.read(fileRecord.path!)
  const filename = fileRecord.filenameDownload || 'file'
  return new Response(new Uint8Array(content), {
    headers: {
      'Content-Type': fileRecord.type!,
      'Content-Length': String(fileRecord.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
    }
  })
})

// 文件删除
app.delete('/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  if (!fileId) {
    throw new HTTPException(400, { message: '缺少文件 ID' })
  }

  const user = requireAuth(c)

  const [fileRecord] = await db.select().from(files).where(eq(files.id, fileId))
  if (!fileRecord) {
    throw new HTTPException(404, { message: '文件不存在' })
  }

  if (fileRecord.uploadedBy !== user.id) {
    throw new HTTPException(403, { message: '无权限删除此文件' })
  }

  try {
    if (fileRecord.path) {
      await storage.delete(fileRecord.path)
    }
  } catch (err) {
    console.error('删除文件失败:', err)
  }

  await db.delete(files).where(eq(files.id, fileId))
  return c.json({ success: true })
})

export default app
