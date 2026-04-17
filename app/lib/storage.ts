import { createHash } from 'crypto'
import path from 'path'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'stream'

// S3 兼容存储客户端（支持 Garage、SeaweedFS、AWS S3、Cloudflare R2、MinIO 等）
export class S3Storage {
  private client: S3Client
  private bucket: string
  private publicDomain?: string
  private pathPrefix: string

  constructor(options: {
    endpoint?: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    bucket: string
    publicDomain?: string
    pathPrefix?: string
    forcePathStyle?: boolean
  }) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      },
      forcePathStyle: options.forcePathStyle ?? false
    })
    this.bucket = options.bucket
    this.publicDomain = options.publicDomain
    this.pathPrefix = options.pathPrefix ?? ''
  }

  private getFullKey(key: string): string {
    return this.pathPrefix ? `${this.pathPrefix}/${key}` : key
  }

  async write(content: Buffer, key: string, contentType?: string): Promise<string> {
    const fullKey = this.getFullKey(key)
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
      Body: content,
      ContentType: contentType || 'application/octet-stream'
    }))
    return fullKey
  }

  async read(key: string): Promise<Buffer> {
    const fullKey = this.getFullKey(key)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey
    }))

    const stream = response.Body as Readable
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.getFullKey(key)
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fullKey
    }))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.read(key)
      return true
    } catch {
      return false
    }
  }

  getPublicUrl(key: string): string | undefined {
    const fullKey = this.getFullKey(key)
    if (this.publicDomain) {
      return `${this.publicDomain}/${fullKey}`
    }
    return undefined
  }
}

// 生成唯一文件名
export function generateUniqueFileName(originalName: string): string {
  const ext = path.extname(originalName) || ''
  const nameWithoutExt = path.basename(originalName, ext).replace(/\s+/g, '-')
  const random = crypto.randomUUID()
  const cleanBase = nameWithoutExt.slice(0, 50).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()
  return `${cleanBase ? `${cleanBase}-` : ''}${random}${ext}`
}

// 按用户分目录组织，用 hash 分散避免单目录文件过多
export function getUserFilePath(userId: string, filename: string): string {
  const hash = createHash('sha1').update(userId).digest('hex')
  const subDir = hash.slice(0, 2)
  return `${subDir}/${userId}/${filename}`
}

// 从环境变量创建存储实例
export function createStorageFromEnv(): S3Storage {
  return new S3Storage({
    endpoint: process.env.STORAGE_S3_ENDPOINT,
    region: process.env.STORAGE_S3_REGION || 'auto',
    accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY!,
    bucket: process.env.STORAGE_S3_BUCKET!,
    publicDomain: process.env.STORAGE_S3_PUBLIC_DOMAIN,
    pathPrefix: process.env.STORAGE_S3_PATH_PREFIX,
    forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true'
  })
}

export const storage = createStorageFromEnv()
