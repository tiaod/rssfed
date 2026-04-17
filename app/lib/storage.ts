import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'stream'

// 存储适配器接口
export interface StorageAdapter {
  /**
   * 写入文件
   * @param content 文件内容
   * @param path 相对存储根的路径
   */
  write(content: Buffer, path: string, contentType?: string): Promise<void>

  /**
   * 读取文件
   * @param path 相对存储根的路径
   */
  read(path: string): Promise<Buffer>

  /**
   * 删除文件
   * @param path 相对存储根的路径
   */
  delete(path: string): Promise<void>

  /**
   * 检查文件是否存在
   */
  exists(path: string): Promise<boolean>

  /**
   * 获取可访问的公开 URL（如果支持）
   */
  getPublicUrl(path: string): string | undefined
}

// 本地文件系统适配器
export class LocalStorageAdapter implements StorageAdapter {
  private rootDir: string
  private publicBaseUrl: string

  constructor(rootDir: string, publicBaseUrl: string = '/uploads') {
    this.rootDir = path.resolve(rootDir)
    this.publicBaseUrl = publicBaseUrl
  }

  private getFullPath(relativePath: string): string {
    // 安全检查，防止路径遍历
    const fullPath = path.join(this.rootDir, relativePath)
    if (!fullPath.startsWith(this.rootDir)) {
      throw new Error('Invalid path: outside storage root')
    }
    return fullPath
  }

  async write(content: Buffer, relativePath: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath)
    const dir = path.dirname(fullPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(fullPath, content)
  }

  async read(relativePath: string): Promise<Buffer> {
    const fullPath = this.getFullPath(relativePath)
    return fs.readFile(fullPath)
  }

  async delete(relativePath: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath)
    try {
      await fs.unlink(fullPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.getFullPath(relativePath))
      return true
    } catch {
      return false
    }
  }

  getPublicUrl(relativePath: string): string {
    return `${this.publicBaseUrl}/${relativePath}`
  }
}

// S3 兼容存储适配器（支持 AWS S3、Cloudflare R2、MinIO 等）
export class S3StorageAdapter implements StorageAdapter {
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

  async write(content: Buffer, key: string, contentType?: string): Promise<void> {
    const fullKey = this.pathPrefix ? `${this.pathPrefix}/${key}` : key
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
      Body: content,
      ContentType: contentType || 'application/octet-stream'
    }))
  }

  async read(key: string): Promise<Buffer> {
    const fullKey = this.pathPrefix ? `${this.pathPrefix}/${key}` : key
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
    const fullKey = this.pathPrefix ? `${this.pathPrefix}/${key}` : key
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fullKey
    }))
  }

  // S3 不存在检查可以省略，读失败会自动抛错
  async exists(key: string): Promise<boolean> {
    try {
      await this.read(key)
      return true
    } catch {
      return false
    }
  }

  getPublicUrl(key: string): string | undefined {
    const fullKey = this.pathPrefix ? `${this.pathPrefix}/${key}` : key
    if (this.publicDomain) {
      // 如果配置了 CDN 域名，用 CDN
      return `${this.publicDomain}/${fullKey}`
    }
    // 否则返回 S3 原生 URL
    return undefined
  }
}

// 工具函数：生成唯一文件名
export function generateUniqueFileName(originalName: string): string {
  const ext = path.extname(originalName) || ''
  const nameWithoutExt = path.basename(originalName, ext).replace(/\s+/g, '-')
  const random = crypto.randomUUID()
  // 保留原始文件名部分信息 + 随机 UUID 避免冲突
  const cleanBase = nameWithoutExt.slice(0, 50).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()
  return `${cleanBase ? `${cleanBase}-` : ''}${random}${ext}`
}

// 工具函数：按用户分目录组织
export function getUserFilePath(userId: string, filename: string): string {
  // 用 hash 前两位做子目录分散，避免一个目录下文件太多
  const hash = createHash('sha1').update(userId).digest('hex')
  const subDir = hash.slice(0, 2)
  return `${subDir}/${userId}/${filename}`
}

// 存储工厂：根据环境配置创建适配器
export function createStorageFromEnv(): StorageAdapter {
  const driver = process.env.STORAGE_DRIVER || 'local'

  if (driver === 'local') {
    const rootDir = process.env.STORAGE_LOCAL_ROOT || './public/uploads'
    const baseUrl = process.env.STORAGE_LOCAL_PUBLIC_URL || '/uploads'
    return new LocalStorageAdapter(rootDir, baseUrl)
  }

  if (driver === 's3') {
    return new S3StorageAdapter({
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

  throw new Error(`Unknown storage driver: ${driver}`)
}

// 默认导出单例
export const storage = createStorageFromEnv()
