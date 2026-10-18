import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'

/**
 * 存储后端统一接口。
 *
 * 两个实现：
 *   - S3Storage：S3 兼容对象存储（SeaweedFS / 云 COS / R2 等）
 *   - FilesystemStorage：本地文件系统（图片量小的时候够用，少一个常驻服务）
 *
 * 由 STORAGE_DRIVER 选择，两侧对 key 的语义完全一致，可随时切换。
 */
/** 列表返回的单个对象（key 是逻辑 key，不含 pathPrefix） */
export interface StorageObjectInfo {
  key: string
  lastModified: Date
  size: number
}

export interface Storage {
  write(content: Buffer, key: string, contentType?: string): Promise<string>
  read(key: string): Promise<Buffer>
  readWithMeta(key: string): Promise<{ content: Buffer; contentType: string }>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /** 列出某前缀下的全部对象（给缓存清理用；只读、可能较慢，不要放请求路径上） */
  list(prefix: string): Promise<StorageObjectInfo[]>
  /** 可直接对外访问的 URL；未配置公开域名时返回 undefined，由调用方回退到 /api/files/* 代理 */
  getPublicUrl(key: string): string | undefined
}

export class S3Storage implements Storage {
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
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle ?? false,
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
      ContentType: contentType || 'application/octet-stream',
    }))
    return fullKey
  }

  async read(key: string): Promise<Buffer> {
    const fullKey = this.getFullKey(key)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
    }))

    const stream = response.Body as Readable
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /** 读取对象并携带 Content-Type（文件代理路由用，避免按扩展名猜类型） */
  async readWithMeta(key: string): Promise<{ content: Buffer; contentType: string }> {
    const fullKey = this.getFullKey(key)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
    }))

    const stream = response.Body as Readable
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return {
      content: Buffer.concat(chunks),
      contentType: response.ContentType ?? "application/octet-stream",
    }
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.getFullKey(key)
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
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

  /** 分页列出前缀下的对象；返回的 key 去掉 pathPrefix，与写入时用的逻辑 key 一致 */
  async list(prefix: string): Promise<StorageObjectInfo[]> {
    const fullPrefix = this.getFullKey(prefix)
    // 逻辑 key → 完整 key 之间差一个 "<pathPrefix>/"，返回时必须切掉
    const stripLength = this.pathPrefix ? this.pathPrefix.length + 1 : 0
    const result: StorageObjectInfo[] = []
    let token: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix,
        ContinuationToken: token,
      }))
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue
        result.push({
          key: object.Key.slice(stripLength),
          lastModified: object.LastModified ?? new Date(0),
          size: object.Size ?? 0,
        })
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (token)
    return result
  }

  getPublicUrl(key: string): string | undefined {
    const fullKey = this.getFullKey(key)
    if (this.publicDomain) {
      return `${this.publicDomain}/${fullKey}`
    }
    return undefined
  }
}

/** 扩展名 → Content-Type：本地存储没有对象元数据，读取时按扩展名推断 */
const MIME_BY_EXT: Record<string, string> = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * 本地文件系统存储：文件落在 STORAGE_FS_DIR（生产环境应挂持久卷）。
 * 上传路径会保留原始扩展名（见 generateUniqueFileName），因此读取时按扩展名推断类型是可靠的。
 */
export class FilesystemStorage implements Storage {
  private root: string
  private publicDomain?: string

  constructor(options: { root: string; publicDomain?: string }) {
    this.root = path.resolve(options.root)
    this.publicDomain = options.publicDomain?.replace(/\/+$/, '')
  }

  /** key → 绝对路径；越界（key 含 ../ 等）直接拒绝，避免路径穿越 */
  private resolvePath(key: string): string {
    const full = path.resolve(this.root, key)
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`非法的存储 key: ${key}`)
    }
    return full
  }

  async write(content: Buffer, key: string): Promise<string> {
    const full = this.resolvePath(key)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
    return key
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key))
  }

  async readWithMeta(key: string): Promise<{ content: Buffer; contentType: string }> {
    return {
      content: await fs.readFile(this.resolvePath(key)),
      contentType: MIME_BY_EXT[path.extname(key).toLowerCase()] ?? 'application/octet-stream',
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolvePath(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(key))
      return true
    } catch {
      return false
    }
  }

  /** 递归列目录；mtime 当 lastModified（缓存清理只按时间判断） */
  async list(prefix: string): Promise<StorageObjectInfo[]> {
    const result: StorageObjectInfo[] = []
    const walk = async (dir: string): Promise<void> => {
      // 目录不存在（还没写过任何对象）等同空列表
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!entries) return
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        try {
          const stat = await fs.stat(full)
          result.push({
            // 统一用 / 作分隔符，与 S3 实现返回的 key 形状一致
            key: path.relative(this.root, full).split(path.sep).join('/'),
            lastModified: stat.mtime,
            size: stat.size,
          })
        } catch {
          // 遍历过程中被删掉：跳过
        }
      }
    }
    await walk(this.resolvePath(prefix))
    return result
  }

  getPublicUrl(key: string): string | undefined {
    // 未配置公开域名时返回 undefined，调用方会回退到 /api/files/* 代理（与 S3 实现一致）
    if (!this.publicDomain) return undefined
    return `${this.publicDomain}/api/files/${key}`
  }
}

export function generateUniqueFileName(originalName: string): string {
  const ext = path.extname(originalName) || ''
  const nameWithoutExt = path.basename(originalName, ext).replace(/\s+/g, '-')
  const random = randomUUID()
  const cleanBase = nameWithoutExt.slice(0, 50).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()
  return `${cleanBase ? `${cleanBase}-` : ''}${random}${ext}`
}

export function getUserFilePath(userId: string, filename: string): string {
  const hash = createHash('sha1').update(userId).digest('hex')
  const subDir = hash.slice(0, 2)
  return `${subDir}/${userId}/${filename}`
}

/**
 * 按 STORAGE_DRIVER 选择存储后端：
 *   - `fs`：本地文件系统（FilesystemStorage），需要 STORAGE_FS_DIR
 *   - `s3`（默认）：S3 兼容对象存储（S3Storage），配置见 STORAGE_S3_*
 *
 * 未知取值直接抛错：命名拼错时宁可启动失败，也不要静默退化到另一个后端。
 */
export function createStorageFromEnv(): Storage {
  const driver = (process.env.STORAGE_DRIVER ?? 's3').trim().toLowerCase()

  if (driver === 'fs') {
    const root = process.env.STORAGE_FS_DIR
    if (!root) {
      throw new Error('STORAGE_DRIVER=fs 时必须设置 STORAGE_FS_DIR')
    }
    return new FilesystemStorage({
      root,
      publicDomain: process.env.STORAGE_FS_PUBLIC_DOMAIN,
    })
  }

  if (driver === 's3') {
    return new S3Storage({
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION || 'auto',
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY!,
      bucket: process.env.STORAGE_S3_BUCKET!,
      publicDomain: process.env.STORAGE_S3_PUBLIC_DOMAIN,
      pathPrefix: process.env.STORAGE_S3_PATH_PREFIX,
      forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
    })
  }

  throw new Error(`未知的 STORAGE_DRIVER: ${driver}（可选 fs | s3）`)
}

export const storage = createStorageFromEnv()
