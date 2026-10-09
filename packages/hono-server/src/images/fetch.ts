import http from "node:http"
import https from "node:https"
import sharp from "sharp"
import { httpAgent, httpsAgent, shouldProxy } from "../rss/parser"

/**
 * 单张远程图片的下载与压缩原语。
 *
 * 从 `rss/entry-images.ts` 抽出来是因为它现在有两个消费者：
 *   1. `rss/entry-images.ts` —— 按**源**的策略把正文图写进 feed 库附件；
 *   2. `images/cache.ts` —— 按**用户**的策略把同一张图写进各自的 timeline 库附件，
 *      以及 `GET /api/images/cached` 的按需压缩（见 routes/images.ts）。
 * 两边必须用同一套下载/解码/压缩实现：不然「同一张图在 feed 库能缓存、在用户库缓存不了」
 * 这种差异会非常难查，也违背了内容寻址缓存「同一 URL + 同一参数只压一次」的前提。
 */

/** 压缩后最大宽度（保持宽高比，小图不放大） */
export const DEFAULT_MAX_IMAGE_WIDTH = parseInt(process.env.MAX_IMAGE_WIDTH ?? "1200")
/** AVIF 编码质量：越低体积越小（正文图片 40-50 即可接受） */
export const DEFAULT_AVIF_QUALITY = parseInt(process.env.AVIF_QUALITY ?? "45")
/** 源图下载大小上限（字节），超出即放弃缓存 */
export const DEFAULT_MAX_SOURCE_IMAGE_BYTES = parseInt(process.env.MAX_SOURCE_IMAGE_BYTES ?? "8388608")
/** 单张源图下载超时（毫秒） */
export const IMAGE_DOWNLOAD_TIMEOUT = 10_000
/** 限制输入像素数，防止超大图耗尽内存 */
export const MAX_INPUT_PIXELS = 40_000_000

/** 图片扩展名兜底（见 looksLikeImage） */
const IMAGE_EXT_RE = /\.(?:avif|webp|png|jpe?g|gif|bmp|tiff?)(?:$|[?#])/i

/**
 * 判断响应是否可能是图片。
 *
 * 只看 `Content-Type: image/*` 会漏掉一批图床：实测 storage.googleapis.com 返回
 * `application/octet-stream`，占失败抽样 URL 的 28%。所以补一层 URL 扩展名兜底，
 * 同时显式拒绝 text/* 与 json/xml/html（避免把防盗链错误页喂给 sharp）。
 * 最终仍由 sharp 解码裁决：解不出来就按 decode 失败跳过，不会写入坏附件。
 */
export function looksLikeImage(url: string, contentType: string): boolean {
  if (contentType.startsWith("image/")) return true
  if (/^(?:text\/|application\/(?:json|xml|html))/i.test(contentType)) return false
  return IMAGE_EXT_RE.test(url)
}

/**
 * 图片下载/压缩失败原因。
 * 这些路径原先全部静默返回 null，导致「为什么没缓存」只能靠反推（见
 * report/image-cache-diagnosis），所以把原因带出来供 worker 聚合成一行日志。
 */
export type ImageFailReason =
  /** 非 200：403 防盗链 / 404 下线 / 5xx */
  | "http-status"
  /** 响应不是图片（html 错误页、octet-stream 且 URL 无图片扩展名） */
  | "content-type"
  /** 源图超过 maxSourceImageBytes，流式读取时被截断放弃 */
  | "too-large"
  /** 连接或读取空闲超时 */
  | "timeout"
  /** DNS 失败、连接重置等网络错误 */
  | "network"
  /** 重定向超过 3 次 */
  | "redirect-limit"
  /** sharp 解不出来（损坏数据、或像素数超 MAX_INPUT_PIXELS） */
  | "decode"
  /** 地址本身不合法，或不是 http(s)（公开的压缩接口必须挡掉 file:/data: 之类） */
  | "invalid-url"

/** 下载结果：成功带 buffer，失败带原因（供聚合统计） */
export interface DownloadOutcome {
  buffer: Buffer | null
  reason?: ImageFailReason
}

/** 下载一张图片（跟随重定向，校验是否图片，限制大小与超时） */
export async function downloadImage(url: string, maxBytes?: number): Promise<DownloadOutcome> {
  try {
    let current = url
    // 最多跟随 3 次重定向
    for (let i = 0; i < 4; i++) {
      const res = await httpGet(current, maxBytes)
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        current = new URL(res.headers.location, current).toString()
        continue
      }
      if (res.status !== 200) return { buffer: null, reason: "http-status" }
      const contentType = (res.headers["content-type"] ?? "").toLowerCase()
      // 扩展名兜底：部分图床把图片标成 application/octet-stream（见 looksLikeImage）
      if (!looksLikeImage(current, contentType)) return { buffer: null, reason: "content-type" }
      return { buffer: res.buffer }
    }
    return { buffer: null, reason: "redirect-limit" }
  } catch (err) {
    // 网络失败/超时/超限：跳过该图并带上原因，不阻塞其余图片
    const msg = (err as Error).message
    if (msg === "image too large") return { buffer: null, reason: "too-large" }
    if (msg === "timeout") return { buffer: null, reason: "timeout" }
    return { buffer: null, reason: "network" }
  }
}

/** 发起 HTTP(S) GET 并流式收集响应体（超时、大小超限时抛错终止） */
function httpGet(url: string, maxBytes?: number): Promise<{ status: number, headers: http.IncomingHttpHeaders, buffer: Buffer }> {
  // 未显式指定时用全局默认上限
  const limit = maxBytes ?? DEFAULT_MAX_SOURCE_IMAGE_BYTES
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http
    const agent = shouldProxy(url) ? (url.startsWith("https:") ? httpsAgent : httpAgent) : undefined
    // 只让第一个结果生效：主动断开连接后还会冒出 error/close 事件，不能覆盖已定结论
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const req = mod.get(url, {
      agent,
      timeout: IMAGE_DOWNLOAD_TIMEOUT,
      // 部分图床/防盗链站点拒绝无 UA 请求
      headers: { "User-Agent": "Mozilla/5.0 (compatible; rssfed/1.0)" },
    }, (res) => {
      const chunks: Buffer[] = []
      let total = 0
      res.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > limit) {
          fail(new Error("image too large"))
          // 关键：destroy **不传 Error**。传了会 emit 出 error 事件，实测在超限路径上
          // 会产生未接管的 error（vitest 直接报 unhandled）；不传则只安静关闭连接。
          res.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on("end", () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) })
      })
      res.on("error", fail)
    })
    req.on("timeout", () => {
      fail(new Error("timeout"))
      req.destroy()
    })
    req.on("error", fail)
  })
}

/** 压缩为 AVIF 小图；解码失败返回 null（导出供测试） */
export async function compressToAvif(
  buffer: Buffer,
  opts: { maxWidth?: number, quality?: number } = {},
): Promise<{ buffer: Buffer, width: number, height: number } | null> {
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH
  const quality = opts.quality ?? DEFAULT_AVIF_QUALITY
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    if (!meta.width || !meta.height) return null
    const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .avif({ quality })
      .toBuffer()
    const outMeta = await sharp(out).metadata()
    return { buffer: out, width: outMeta.width ?? meta.width, height: outMeta.height ?? meta.height }
  } catch {
    return null // 非图片/损坏数据：跳过
  }
}

/**
 * 只读一张已压缩图片的像素尺寸。
 *
 * 给缓存命中但元数据 sidecar 缺失的场景兜底（见 images/cache.ts）：解码一张 AVIF 的头部
 * 比重新下载压缩便宜得多，代价是每张图一次 sharp metadata。
 */
export async function probeImageSize(buffer: Buffer): Promise<{ width: number, height: number } | null> {
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    if (!meta.width || !meta.height) return null
    return { width: meta.width, height: meta.height }
  } catch {
    return null
  }
}
