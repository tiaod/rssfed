import crypto from "node:crypto"
import zlib from "node:zlib"
import { storage as defaultStorage, type Storage } from "../storage"
import { fetchFeed, type FeedValidators } from "./parser"
import { envInt } from "../env"

/**
 * 抓取缓存：**按 URL** 缓存 feed 正文与条件请求验证器。
 *
 * ## 它解决的问题
 *
 * 新模型下抓取按 **owner** 各自进行（一个用户一个 job，Bot 各自一个 job），同一个源被
 * N 个 owner 订阅就抓 N 次。这层缓存把「同一个 URL 在 TTL 内只真正发一次请求」做到，
 * 于是 N 次抓取退化成 1 次网络请求 + N-1 次缓存命中。它是这套设计里**唯一的跨 owner 共享**。
 *
 * ## 为什么缓存的是「正文 + 验证器」而不是解析后的条目
 *
 * - 正文与 ETag/Last-Modified 都是 **URL 的属性**，与谁在抓无关，天然可共享；
 * - 解析结果是 feedsmith 的产物，几毫秒的事，缓存它反而要处理「解析器升级后缓存失效」，
 *   而且解析结果里带着 owners 各自的写入状态，共享不了。
 *
 * ## 两道闸门，缺一不可
 *
 * 1. **TTL**：命中且足够新就直接用，连条件请求都不发。TTL 太短则同一 tick 内 N 个 owner
 *    挨个打外网，太长则内容陈旧。默认 10 分钟（小于 15 分钟的基础抓取间隔）。
 * 2. **进程内单飞**：同一个 URL 的 N 个 job 若同时开跑（`FETCH_CONCURRENCY=4` 时很容易
 *    撞上），只放一个出去，其余等它的结果。**单飞只在单进程内有效** —— 多副本部署时
 *    退化成「每个副本各发一次」，这是已知边界，不是 bug（见 `inflight` 注释）。
 *
 * ## 缓存对象是可丢弃的中间产物
 *
 * 与图片缓存同性质：删掉最多是下次多下一次。所以按 TTL 清理（`gcFetchCache`），
 * 不参与任何一致性保证。**用户库里的条目才是数据**，缓存对象不是。
 */

/** 缓存前缀：与 `image-cache/` 分开，便于按前缀清理/统计 */
export const FETCH_CACHE_PREFIX = "fetch-cache"

/** key 结构版本：改存储格式/压缩方式时 +1，旧对象随即失效 */
export const FETCH_CACHE_VERSION = 2

/** 默认 TTL：小于基础抓取间隔（15 分钟），保证「一个 tick 内同源只出一次网」 */
const DEFAULT_TTL_MS = envInt("FETCH_CACHE_TTL_MS", 10 * 60 * 1000, { min: 0 })

/** 缓存对象里记的元数据（与正文分开存，命中路径不必解压正文就能判断有效期） */
export interface FetchCacheMeta {
  version: number
  url: string
  fetchedAt: string
  /** 与正文一起缓存的验证器；下一次条件请求带上它 */
  etag?: string
  lastModified?: string
  validatorUrl?: string
  /** 上次成功响应是否带回验证器（自适应调度的输入） */
  hasValidators: boolean
  /** 正文对象的 key（gzip 后的 utf-8 文本） */
  bodyKey: string
  bodyBytes: number
}

export interface CachedFeed {
  content: string
  meta: FetchCacheMeta
  /** true = 没有发网络请求，直接用的缓存 */
  fromCache: boolean
}

export type FetchOutcome =
  | { ok: true, content: string, meta: FetchCacheMeta, fromCache: boolean }
  | { ok: false, error: unknown }

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

/** 该 URL 的缓存 key 前缀（不含扩展名，便于一次列出 meta 与 body） */
export function fetchCacheKey(url: string): string {
  return `${FETCH_CACHE_PREFIX}/v${FETCH_CACHE_VERSION}/${sha256(url)}`
}

function metaKey(url: string): string {
  return `${fetchCacheKey(url)}/meta.json`
}

function bodyKey(url: string): string {
  return `${fetchCacheKey(url)}/body.gz`
}

/** 依赖注入点（测试用；生产走默认实现） */
export interface FetchCacheDeps {
  storage?: Storage
  now?: () => number
  /** 真正发请求的函数（默认 `fetchFeed`） */
  fetch?: typeof fetchFeed
  ttlMs?: number
}

/**
 * 读到 meta（不存在/损坏都返回 null）。
 *
 * 损坏按"没有缓存"处理：缓存对象随时可丢，不该因为一个坏 JSON 让这个源的抓取永久失败。
 */
async function readMeta(store: Storage, url: string): Promise<FetchCacheMeta | null> {
  try {
    const buf = await store.read(metaKey(url))
    const meta = JSON.parse(buf.toString("utf-8")) as FetchCacheMeta
    if (meta.version !== FETCH_CACHE_VERSION || meta.url !== url) return null
    return meta
  } catch {
    return null
  }
}

async function writeMeta(store: Storage, meta: FetchCacheMeta): Promise<void> {
  await store.write(Buffer.from(JSON.stringify(meta)), metaKey(meta.url), "application/json")
}

async function writeBody(store: Storage, url: string, content: string): Promise<void> {
  const gz = zlib.gzipSync(Buffer.from(content, "utf-8"))
  await store.write(gz, bodyKey(url), "application/gzip")
}

async function readBody(store: Storage, url: string): Promise<string | null> {
  try {
    const gz = await store.read(bodyKey(url))
    return zlib.gunzipSync(gz).toString("utf-8")
  } catch {
    return null
  }
}

/**
 * 进程内单飞：同一个 URL 同时只有一个真正的抓取在跑。
 *
 * **作用域是进程**：多副本部署时每个副本各有一张表，N 个 owner 落在不同副本上就会各发一次。
 * 要跨副本合并就得换成 Redis 锁，而锁的失效/脑裂语义带来的复杂度超过它省下的那点 egress
 * （当前部署是单进程；有多副本需求时再评估，别提前上）。
 */
const inflight = new Map<string, Promise<FetchOutcome>>()

/**
 * 取一个 feed 的正文：优先缓存、其次条件请求、最后全量。
 *
 * 关键分支（每一条都对应一类真实的失败）：
 *   - 缓存新鲜 → 直接返回，**不发网络请求**；
 *   - 缓存过期但带验证器 → 条件请求；304 且**正文还在** → 用缓存正文，只刷新 `fetchedAt`；
 *   - 304 但正文不见了（被 GC 删掉）→ 再发一次**不带验证器**的请求，否则永远拿不到内容；
 *   - 任何网络错误 → 抛出，由调用方记进 owner 的调度状态（不吞，否则调度永远看不到失败）。
 *
 * 写缓存失败（对象存储抖动）不致命：这一轮照常用内存里的正文，只是下次还得重抓。
 */
export async function getFeedContent(
  url: string,
  deps: FetchCacheDeps = {},
): Promise<CachedFeed> {
  const existing = inflight.get(url)
  if (existing) {
    const result = await existing
    if (!result.ok) throw result.error
    // 等到了别人抓的结果：对调用方而言这就是一次"没发请求"的命中（内容同一份）
    return { content: result.content, meta: result.meta, fromCache: true }
  }
  const task = runFetch(url, deps).finally(() => {
    inflight.delete(url)
  })
  inflight.set(url, task)
  const result = await task
  if (!result.ok) throw result.error
  return { content: result.content, meta: result.meta, fromCache: result.fromCache }
}

async function runFetch(url: string, deps: FetchCacheDeps): Promise<FetchOutcome> {
  const store = deps.storage ?? defaultStorage
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const doFetch = deps.fetch ?? fetchFeed

  const cached = await readMeta(store, url)
  const ageMs = cached ? now() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY

  // ① 新鲜命中：连条件请求都不发。这是"多 owner 订阅同源"省下 egress 的主要路径。
  if (cached && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs) {
    const body = await readBody(store, url)
    if (body !== null) return { ok: true, content: body, meta: cached, fromCache: true }
    // 正文被 GC 掉了：落到下面重新抓（meta 还在，验证器可用）
  }

  // ② 带验证器做条件请求。验证器来源 URL 必须与目标一致（重定向后换了地址就不该带）。
  const validators: FeedValidators | undefined = cached
    ? {
        url: cached.validatorUrl,
        etag: cached.etag,
        lastModified: cached.lastModified,
      }
    : undefined

  let fetched
  try {
    fetched = await doFetch(url, validators)
  } catch (error) {
    return { ok: false, error }
  }

  if (fetched.notModified) {
    const body = cached ? await readBody(store, url) : null
    if (body !== null && cached) {
      // 304 只刷新时间戳：正文与验证器都不动（服务端没说变，那就是没变）
      const meta: FetchCacheMeta = {
        ...cached,
        fetchedAt: new Date(now()).toISOString(),
        hasValidators: true,
      }
      if (fetched.etag) meta.etag = fetched.etag
      if (fetched.lastModified) meta.lastModified = fetched.lastModified
      if (fetched.validatorUrl) meta.validatorUrl = fetched.validatorUrl
      await writeMeta(store, meta).catch(() => {})
      return { ok: true, content: body, meta, fromCache: true }
    }
    // 304 但手上没有正文（缓存被删/首次就 304）：必须再要一次完整内容，
    // 否则这个源会陷入"永远 304、永远没有内容"的死循环。
    try {
      fetched = await doFetch(url, undefined)
    } catch (error) {
      return { ok: false, error }
    }
    if (fetched.notModified) {
      // 不发验证器仍然 304：服务端行为异常，按失败处理（宁可报错，也不要假装成功）
      return { ok: false, error: new Error("服务端在无条件请求下仍返回 304") }
    }
  }

  const content = fetched.content
  const hasValidators = Boolean(fetched.etag || fetched.lastModified)
  // 正文对象先落，再把 meta 指向它：反过来会让"meta 存在、正文不存在"的窗口里
  // 每次都命中不了缓存（上面的 ① 会 fallthrough 到 ②，不算错，只是多一轮请求）。
  try {
    await writeBody(store, url, content)
  } catch {
    // 写不进缓存不影响本轮：调用方拿到的是内存里的正文
  }
  const meta: FetchCacheMeta = {
    version: FETCH_CACHE_VERSION,
    url,
    fetchedAt: new Date(now()).toISOString(),
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    validatorUrl: fetched.validatorUrl,
    hasValidators,
    bodyKey: bodyKey(url),
    bodyBytes: Buffer.byteLength(content, "utf-8"),
  }
  await writeMeta(store, meta).catch(() => {})
  return { ok: true, content, meta, fromCache: false }
}

/**
 * 只读该 URL 的缓存元数据（不读正文、不发请求）。
 *
 * 抓取 worker 用它判断"这个源有没有条件请求验证器"（自适应降频的输入）——
 * 刚抓完就读得到，不必为了这个信息再发一次请求。
 */
export async function readFetchCacheMeta(
  url: string,
  deps: Pick<FetchCacheDeps, "storage"> = {},
): Promise<FetchCacheMeta | null> {
  return await readMeta(deps.storage ?? defaultStorage, url)
}

/** 测试用：清掉进程内单飞表（否则用例之间会互相命中） */
export function resetFetchCacheInflight(): void {
  inflight.clear()
}

/**
 * 丢弃某个 URL 的缓存（源地址不变、但需要强制重抓时用，例如"立即抓取"按钮）。
 *
 * 只删正文与 meta；删不掉不算错（缓存本来就可丢，最坏情况是这一轮读到旧正文）。
 */
export async function invalidateFetchCache(url: string, deps: FetchCacheDeps = {}): Promise<void> {
  const store = deps.storage ?? defaultStorage
  await Promise.all([
    store.delete(metaKey(url)).catch(() => {}),
    store.delete(bodyKey(url)).catch(() => {}),
  ])
}
