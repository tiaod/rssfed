import { Worker, Queue } from "bullmq"
import crypto from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { ensureFeedDatabase, createCouchDb } from "../couchdb/client"
import { createTrimDb, trimSourceToLatestN, DEFAULT_SOURCE_RETENTION_ENTRIES } from "../couchdb/retention"
import { feedDocId } from "../couchdb/doc-ids"
import {
  fetchParsedFeed,
  formatFeedError,
  MAX_FEED_BYTES,
  MAX_FEED_DECODED_BYTES,
  type FeedValidators,
  type ParsedFeed,
  type ParsedItem,
} from "../rss/parser"
import { cacheEntryImages, cacheSingleImage, FEED_ICON_CACHE_VERSION, type EntryImageOptions } from "../rss/entry-images"
import { db, feeds, type EntryDoc } from "../db"
import { connection, createWorkerConnection } from "./connection"
import { isFeedDue, feedJitterMs, type FetchScheduleOptions } from "./fetch-schedule"
import { selectNewestItems } from "./entry-selection"
import { enqueueFetchJob } from "./enqueue"
import { buildFeedRegistryUpdate } from "./feed-registry"
import { notifyTimelineStale, shutdownTimelineWorkers } from "./timeline"
import { enqueueBotCopy, shutdownBotCopyWorkers } from "./bot-sync"
import { shutdownTimelineMaintenance, startTimelineMaintenance } from "./maintenance"
import { envInt, formatDuration } from "../env"
import { IMAGE_CONCURRENCY } from "../images/concurrency"

export const fetchQueue = new Queue("rss-fetch", { connection })

type FeedDb = ReturnType<typeof createCouchDb>

/**
 * 抓取并发度：单个源最慢要拖满 10s（没有代理时直连被墙站点必然超时），串行跑 700+ 个源
 * 会让队列永远追不上 15 分钟的调度间隔（2026-10-10 实测积压 600+，一条 refetch 要排十几分钟）。
 * 默认 4，可用 FETCH_CONCURRENCY 调整。
 */
const FETCH_CONCURRENCY = envInt("FETCH_CONCURRENCY", 4)

/**
 * 抓取 job 的 payload。
 *
 * `couchDbName` / `imageOptions` 由调度器在同一个 SQL 里带出来：稳态下 worker 可以少查
 * 1–2 次 PostgreSQL（705 源 × 每轮 1 次已经不小）。手工「立即抓取」/ 首抓 / 老 Redis 里
 * 残留的 job 不带这两项，worker 回退到原来的查询路径。
 */
interface FetchJobData {
  feedId: string
  url: string
  couchDbName?: string | null
  imageOptions?: EntryImageOptions
}

/**
 * 测试进程里不启动 worker。
 *
 * mcp.test.ts / health.test.ts 会 `import "../app"`，把本模块整个拉进测试进程；模块顶层的
 * `new Worker(...)` 会让测试跑起来就去消费**真实 Redis 队列**——抢走线上待抓任务，而且测试
 * 进程没有加载 .env：RSSHUB_BASE_URL 为空（跳过本地 RSSHub 改写，直接打 rsshub.app 超时）、
 * PG 用默认 DSN 连不上（markFeedError 写库失败）。2026-10-10 跑一次全量测试就吃掉 2 个刚入队的 job。
 */
const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

export const worker = isTestProcess ? null : new Worker("rss-fetch", async (job) => {
  const { feedId, url, couchDbName, imageOptions } = job.data as FetchJobData

  try {
    // 调度器已带出库名时跳过「按 feedId 查 PG」（稳态路径）
    const feedDbName = await ensureFeedDatabase(feedId, couchDbName)
    const feedDb = createCouchDb(feedDbName)

    // 先读 FeedDoc：拿上次响应头里的 ETag/Last-Modified（条件请求），
    // 顺带省掉 updateFeedDoc 里再 get 一次。
    const previous = await readFeedDoc(feedDb, feedId)
    const fetched = await fetchParsedFeed(url, previous.validators)

    // 304：内容没变。只刷抓取时间、清掉上一轮错误，不写条目、不通知 Bot。
    // 这是省流量的关键路径 —— 绝大多数轮次都会走到这里，一个正文字节都不用传。
    // （唯一的例外是下面的补裁剪：上一轮没裁剪完时它仍可能产生删除并通知时间线。）
    if (fetched.notModified) {
      await markFeedNotModified(feedDb, feedId, previous.doc)
      // 自愈：上一轮可能「写入成功但裁剪没跑完/失败」，而 304 之后不再走写入分支，
      // 那条源会永远停在超限状态。这里补一次裁剪 —— 稳态下 total<=N，只是一次视图查询（几毫秒）。
      const trim = await trimSourceToLatestN(createTrimDb(feedDbName), { compact: false })
      if (trim.deleted > 0) {
        // 删除同样算「源内容变了」，否则只删不增的源永远触发不了用户库同步
        await db.update(feeds).set({ lastChangedAt: new Date() }).where(eq(feeds.id, feedId))
        void notifyTimelineStale(feedId).catch(() => {})
      }
      return { feedId, notModified: true, newEntries: 0, trimmed: trim.deleted, totalItems: 0 }
    }

    const parsed = fetched.feed

    // 依次更新 FeedDoc 元数据、PostgreSQL 注册表，再写入新条目并通知相关 Bot
    const iconCached = await updateFeedDoc(feedDb, feedId, url, parsed, previous.doc, {
      // 验证器必须连同来源 URL 一起存：重定向过的源（如 macworld、baoyu）最终资源在另一跳，
      // 下一轮只有走到那一跳才会带条件头、拿到 304；少存 url 就等于每轮都全量重下。
      url: fetched.validatorUrl,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    })
    await updateFeedRegistry(feedId, url, parsed)
    const newEntries = await insertNewEntries(feedDb, feedId, parsed.items ?? [], imageOptions)
    // 源库保留策略：每条源只留最新 N 条 —— 整个保留链路的唯一权威
    // （见 docs/notes/aggregation/source-side-retention-plan.md）。
    // 超限才动数据；拿不到边界时一条都不删。compact 不放在这里：删除只产生墓碑，
    // 附件字节由 CouchDB 自身的 [compactions] 或定时 compact 回收。
    const trim = await trimSourceToLatestN(createTrimDb(feedDbName), { compact: false })
    // 两个时间戳语义不同，别混：
    //   lastNewEntryAt → "抓到新内容"（前端"最后更新"用）
    //   lastChangedAt  → "源内容变了"（脏源判定用；**裁剪删除也算**，否则只删不增的源永不触发同步）
    const now = new Date()
    const patch: {
      lastNewEntryAt?: Date
      lastChangedAt?: Date
      errorStreak: number
      hasFetchValidators: boolean
    } = {
      // 成功抓到 200：错误计数归零，并记下「这个源有没有条件请求验证器」（调度器据此降频）
      errorStreak: 0,
      hasFetchValidators: Boolean(fetched.etag || fetched.lastModified),
    }
    if (newEntries.length > 0 || iconCached) patch.lastNewEntryAt = now
    if (newEntries.length > 0 || iconCached || trim.deleted > 0) patch.lastChangedAt = now
    await db.update(feeds).set(patch).where(eq(feeds.id, feedId))
    // Bot 产出复制挪到独立队列（带 attempts 重试）：失败不再静默丢条，也不拖慢抓取。
    // 无新条目时也入队一次 —— Bot 库里的 FeedDoc 元信息（名字/头像）需要校正。
    void enqueueBotCopy(feedId, newEntries.map((entry) => entry._id))
      .catch((err) => console.warn(`[Bot] 产出复制入队失败 ${feedId}:`, (err as Error)?.message ?? err))

    // 有新条目**或裁掉了条目** → 通知各用户的时间线聚合尽快跑一轮（带节流：一轮抓取里几十个源
    // 都有变化时只通知一次）。聚合本身是增量的，安静时每个用户只花一条 SQL。
    if (newEntries.length > 0 || trim.deleted > 0) {
      void notifyTimelineStale(feedId).catch(() => {})
    }

    return { feedId, newEntries: newEntries.length, trimmed: trim.deleted, totalItems: parsed.items?.length ?? 0 }
  } catch (err) {
    // 抓取失败，更新 feed 注册表的 errorMessage 与连续失败次数（调度器按它指数退避）
    await markFeedError(feedId, url, err)
    throw err
  }
}, { connection: createWorkerConnection(), concurrency: FETCH_CONCURRENCY })

/**
 * 从 FeedDoc 读出上次响应的 HTTP 验证器（ETag / Last-Modified），供条件请求使用。
 *
 * 验证器跟着 FeedDoc 走、而不是写进 PostgreSQL：FeedDoc 本来每轮抓取都要读/写一次，
 * 放这里不需要给 `feeds` 表加列（也就不用为一个纯抓取优化动生产库结构）。
 * 两者都是源码不变量里的"抓取中间状态"，不是用户数据。
 */
async function readFeedDoc(feedDb: FeedDb, feedId: string): Promise<{ doc: any | null, validators: FeedValidators }> {
  try {
    const doc = await feedDb.get(feedDocId(feedId)) as any
    // fetchValidatorUrl 是验证器来源的最终 URL（重定向链最后一跳）；老文档没有这个字段时
    // 沿用「只对第一跳生效」的旧语义，下一次成功抓取后会被补上。
    return {
      doc,
      validators: {
        url: doc.fetchValidatorUrl,
        etag: doc.fetchEtag,
        lastModified: doc.fetchLastModified,
      },
    }
  } catch {
    // 首次抓取（FeedDoc 还没建）或读取失败：当作没有验证器，退化为普通全量抓取
    return { doc: null, validators: {} }
  }
}

/**
 * 304 之后刷新 FeedDoc 与注册表：只碰 lastFetchedAt / errorMessage。
 *
 * 这里**不能**复用 updateFeedDoc：它写的是 title/description/image 等抓取结果，
 * 而 304 意味着这一轮根本没有新值；更重要的是别把上一轮残留的 errorMessage 带回来
 * （304 本身是成功响应，说明源是好的）。
 *
 * FeedDoc 的 `lastFetchedAt` 只给离线兜底展示用，不必每轮 304 都写一次
 * （约 6.6k 次写/天）：1 小时粒度足够，只有「上一轮有错误要清」或「上次写已是 1 小时前」才写。
 * PostgreSQL 的 lastFetchedAt 仍然每轮都更新 —— 调度器靠它算下一轮。
 */
const FEED_DOC_TOUCH_INTERVAL_MS = 60 * 60 * 1000

async function markFeedNotModified(feedDb: FeedDb, feedId: string, existing: any): Promise<void> {
  const nowMs = Date.now()
  const lastDocFetch = Date.parse(existing?.lastFetchedAt ?? "")
  const docStale = !Number.isFinite(lastDocFetch) || nowMs - lastDocFetch >= FEED_DOC_TOUCH_INTERVAL_MS
  if (existing && (existing.errorMessage || docStale)) {
    try {
      // errorMessage: undefined 会被 nano 的 JSON.stringify 丢掉，等效于从文档里清掉该字段
      await feedDb.insert({ ...existing, lastFetchedAt: new Date(nowMs).toISOString(), errorMessage: undefined } as any)
    } catch (err) {
      // FeedDoc 写失败不影响这一轮：下一轮会带同样的验证器回来，304 之后还会再试一次
      console.warn(`[Fetch] 304 后更新 FeedDoc 失败 ${feedId}:`, (err as any)?.message ?? err)
    }
  }
  await db.update(feeds).set({
    lastFetchedAt: new Date(nowMs),
    errorMessage: null,
    // 304 说明条件请求验证器可用：错误清零，并标记为「有验证器」（调度器不提前降频）
    errorStreak: 0,
    hasFetchValidators: true,
  }).where(eq(feeds.id, feedId))
}

/**
 * 更新（或首次创建）CouchDB 中的 FeedDoc 元数据；返回是否首次缓存了图标（用于触发前端同步）。
 *
 * @param existing 调用方在抓取**之前**读到的 FeedDoc（见 readFeedDoc），避免再 get 一次
 * @param validators 本次响应头里的 ETag / Last-Modified，随 FeedDoc 存下来供下一轮条件请求
 */
async function updateFeedDoc(
  feedDb: FeedDb,
  feedId: string,
  url: string,
  parsed: ParsedFeed,
  existing: any | null,
  validators: FeedValidators,
): Promise<boolean> {
  const imageUrl = parsed.image?.url
  // 这个函数里所有 CouchDB 文档名（get / insert / multipart 附件）都必须用 docId：
  // 下划线开头的 feedId 直接当文档 id 会被 CouchDB 拒（见 couchdb/doc-ids.ts），
  // 带图标的源会因为图标附件那条 multipart 写入而整轮抓取失败。
  const docId = feedDocId(feedId)
  // 条件请求的验证器：本次没拿到（服务端不给了）就保留旧的。
  // validatorUrl 必须与验证器一起更新：否则改了重定向目标后，会拿旧资源的 ETag 去问新地址。
  const fetchMeta = {
    fetchValidatorUrl: validators.url ?? existing?.fetchValidatorUrl,
    fetchEtag: validators.etag ?? existing?.fetchEtag,
    fetchLastModified: validators.lastModified ?? existing?.fetchLastModified,
  }

  if (existing) {
    const doc = {
      ...existing,
      title: parsed.title ?? existing.title,
      description: parsed.description ?? existing.description,
      siteUrl: parsed.link ?? existing.siteUrl,
      image: imageUrl ?? existing.image,
      lastFetchedAt: new Date().toISOString(),
      // CouchDB 文档这里用 undefined 是对的：nano 会 JSON.stringify，undefined 的键直接被丢掉，
      // 新 revision 里不再有 errorMessage，等效于清空。（SQL 那边不能这么写，见 feed-registry.ts）
      errorMessage: undefined,
      ...fetchMeta,
    }
    // feed 图标缓存：URL 变化、或压缩参数版本升级（见 FEED_ICON_CACHE_VERSION）时
    // 重新下载压缩为 AVIF 附件；失败静默跳过。
    // 版本判断不能省：附件名固定为 feed-image.avif，光比 URL 发现不了参数变化。
    const iconStale = !existing.imageCached
      || imageUrl !== existing.imageCached.url
      || existing.imageCached.v !== FEED_ICON_CACHE_VERSION
    if (imageUrl && iconStale) {
      const cached = await cacheSingleImage(imageUrl)
      if (cached) {
        await feedDb.multipart.insert({ ...doc, imageCached: cached.image } as any,
          [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }],
          { docName: docId, rev: existing._rev })
        return true // 图标首次缓存：touch lastNewEntryAt，触发前端同步拉取附件
      }
    }
    await feedDb.insert(doc as any)
    return false
  }

  // FeedDoc 不存在，首次插入
  const doc: any = {
    _id: docId,
    type: "feed",
    url,
    title: parsed.title ?? url,
    description: parsed.description,
    siteUrl: parsed.link,
    lastFetchedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...fetchMeta,
  }
  // 首次建库时也尝试缓存图标（用原 URL 作为 imageCached 判断基准：首次无缓存）
  if (imageUrl) {
    const cached = await cacheSingleImage(imageUrl)
    if (cached) {
      doc.image = imageUrl
      doc.imageCached = cached.image
      await feedDb.multipart.insert(doc, [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }], { docName: docId })
      return true
    }
  }
  await feedDb.insert(doc)
  return false
}

/** 更新 PostgreSQL feed 注册表 */
async function updateFeedRegistry(feedId: string, url: string, parsed: ParsedFeed) {
  await db.update(feeds).set(buildFeedRegistryUpdate(url, parsed)).where(eq(feeds.id, feedId))
}

/** 一次 `_all_docs` keys 查询的条数：CouchDB 对 POST body 有上限，500 足够且往返次数可忽略 */
const EXISTENCE_CHECK_CHUNK = 500

/** 候选新条目（guid 已解析成确定性 doc id） */
interface EntryCandidate {
  item: ParsedItem
  guid: string
  entryId: string
}

/**
 * 批量判断候选条目在源库里的状态：已存在（含活文档）→ 跳过；墓碑 → 跳过；从未出现 → 待写入。
 *
 * 逐条 `get` 在「一次列出上千条的源」上很贵（实测 1982 条 = 1982 次往返 6.2s），
 * 而 POST `_all_docs` 的 keys 查询一次能拿 500 条（0.22s）。
 *
 * 墓碑必须与「已存在」一样跳过：源里通常还列着被保留策略裁掉的老条目，写回去就是复活
 * （实测同一条 entry 攒到 68 个修订、库里有 1600+ 墓碑），而且 newEntries 非空会把
 * `lastChangedAt` 每轮刷成「有变化」，触发无意义的聚合复制。墓碑的语义就是「别再回来」。
 */
async function partitionByExistence(feedDb: FeedDb, candidates: EntryCandidate[]) {
  const present = new Set<string>()
  const tombstoned = new Set<string>()
  for (let i = 0; i < candidates.length; i += EXISTENCE_CHECK_CHUNK) {
    const chunk = candidates.slice(i, i + EXISTENCE_CHECK_CHUNK)
    const res = await feedDb.fetch({ keys: chunk.map((c) => c.entryId) }) as {
      rows?: Array<{ key?: string, id?: string, error?: string, value?: { rev?: string, deleted?: boolean } }>
    }
    for (const row of res.rows ?? []) {
      const id = row.key ?? row.id
      if (!id) continue
      if (row.error === "not_found") continue // 从未出现：待写入
      if (row.value?.deleted) {
        tombstoned.add(id) // 已裁掉的旧条目
        continue
      }
      // 既不是 not_found 又没有 value 的异常行：按「已存在」处理（宁可漏写，也不要写重复/复活）
      present.add(id)
    }
  }
  return { present, tombstoned }
}

/**
 * 写入新条目到 per-feed CouchDB 库，返回本次新增的条目列表。
 *
 * @param imageOptions 调度器随 job data 带出的 per-feed 图片策略；不传时现查一次 PG
 */
async function insertNewEntries(
  feedDb: FeedDb,
  feedId: string,
  items: ParsedItem[],
  imageOptions?: EntryImageOptions,
) {
  const newEntries: EntryDoc[] = []
  // ① 只处理保留窗口内的最新 N 条：超出 N 的条目下一刻就会被裁掉，先写再删纯属写放大
  //   （首次订阅历史型源时尤其明显：实测一个源列 1982 条 → 1982 次写 + 1932 个墓碑）。
  const candidates: EntryCandidate[] = []
  const deduped = new Set<string>()
  for (const item of selectNewestItems(items, DEFAULT_SOURCE_RETENTION_ENTRIES)) {
    const guid = item.guid ?? item.link ?? item.title ?? ""
    const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`
    // 同一批里 guid 重复的条目只保留第一条：批量判存在后它们都会被当成新条目，写第二次会 409
    if (deduped.has(entryId)) continue
    deduped.add(entryId)
    candidates.push({ item, guid, entryId })
  }
  // ② 一次批量判存在（含墓碑）
  const { present, tombstoned } = await partitionByExistence(feedDb, candidates)
  // per-feed 图片策略：优先用调度器带出来的（省一次 PG 查询），没有则现查
  const resolvedImageOptions = imageOptions ?? await resolveFeedImageOptions(feedId)
  // 本次抓取的图片缓存汇总：逐张打日志会把 600+ 源的日志刷爆，所以循环结束后聚合成一行
  const imgAgg = {
    candidates: 0, skippedLimit: 0, skippedBudget: 0, cached: 0, failed: 0, bytes: 0,
    reasons: {} as Record<string, number>,
  }
  for (const { item, guid, entryId } of candidates) {
    if (present.has(entryId) || tombstoned.has(entryId)) continue

    const entry = buildEntry(feedId, item, guid, entryId)
    // 下载并压缩正文图片为 AVIF 附件，与条目一次写入（multipart）；
    // 协议封面（media:thumbnail/图片 enclosure）优先作为封面，正文图回退；
    // 图片缓存失败不阻塞抓取，回退为无图条目（前端保留原 URL 直链）
    try {
      const { attachments, images, stats } = await cacheEntryImages(entry.content, entry.url, item.coverUrl, resolvedImageOptions)
      imgAgg.candidates += stats.candidates
      imgAgg.skippedLimit += stats.skippedByLimit
      imgAgg.skippedBudget += stats.skippedByBudget
      imgAgg.cached += stats.cached
      imgAgg.failed += stats.failed
      imgAgg.bytes += stats.bytes
      for (const [reason, count] of Object.entries(stats.reasons)) {
        imgAgg.reasons[reason] = (imgAgg.reasons[reason] ?? 0) + (count ?? 0)
      }
      if (images.length > 0) {
        // nano 的 multipart.insert 需在 params 中显式传入 docName
        await feedDb.multipart.insert({ ...entry, images } as any, attachments, { docName: entryId })
        newEntries.push(entry)
        continue
      }
    } catch (err) {
      console.warn(`[EntryImages] 图片缓存失败，回退原始条目 ${entryId}:`, err)
    }
    await feedDb.insert(entry as any)
    newEntries.push(entry)
  }
  // 仅在有失败时输出，作为「为什么没缓存」的可观测入口（无失败则保持安静）
  if (imgAgg.failed > 0) {
    const reasons = Object.entries(imgAgg.reasons).map(([k, v]) => `${k}=${v}`).join(" ") || "-"
    console.warn(
      `[EntryImages] feed=${feedId} 候选=${imgAgg.candidates} 缓存=${imgAgg.cached} 失败=${imgAgg.failed} ` +
      `超张数=${imgAgg.skippedLimit} 超预算=${imgAgg.skippedBudget} 附件=${(imgAgg.bytes / 1024).toFixed(0)}KB 原因[${reasons}]`,
    )
  }
  return newEntries
}

/** feeds 表里与 per-feed 图片缓存策略相关的列（job data 与现查路径共用同一份列定义） */
const feedImageColumns = {
  cacheImages: feeds.cacheImages,
  maxImageCount: feeds.maxImageCount,
  maxEntryImageBytes: feeds.maxEntryImageBytes,
  maxImageWidth: feeds.maxImageWidth,
  avifQuality: feeds.avifQuality,
  maxSourceImageBytes: feeds.maxSourceImageBytes,
}

type FeedImageRow = Pick<
  typeof feeds.$inferSelect,
  "cacheImages" | "maxImageCount" | "maxEntryImageBytes" | "maxImageWidth" | "avifQuality" | "maxSourceImageBytes"
>

/** 把 feeds 行映射成 entry-images 的 per-feed 覆盖项（未设置的字段不出现，走全局默认） */
function imageOptionsFromFeedRow(feed: FeedImageRow | null | undefined): EntryImageOptions {
  if (!feed) return {}
  return {
    cacheAll: feed.cacheImages ?? false,
    maxImageCount: feed.maxImageCount ?? undefined,
    maxEntryImageBytes: feed.maxEntryImageBytes ?? undefined,
    maxImageWidth: feed.maxImageWidth ?? undefined,
    avifQuality: feed.avifQuality ?? undefined,
    maxSourceImageBytes: feed.maxSourceImageBytes ?? undefined,
  }
}

/** 从 feeds 表读取该 feed 的 per-feed 图片缓存配置（job data 没带时的回退路径） */
async function resolveFeedImageOptions(feedId: string): Promise<EntryImageOptions> {
  try {
    const [feed] = await db.select(feedImageColumns).from(feeds).where(eq(feeds.id, feedId)).limit(1)
    return imageOptionsFromFeedRow(feed)
  } catch {
    // 读取配置失败不影响抓取，走全局默认
    return {}
  }
}

/** 抓取失败时记录错误到 feed 注册表 */
async function markFeedError(feedId: string, url: string, err: unknown) {
  await db.update(feeds).set({
    errorMessage: formatFeedError(url, err),
    lastFetchedAt: new Date(),
    // 连续失败次数 +1：调度器据此指数退避（成功抓取后由 worker 归零）
    errorStreak: sql`${feeds.errorStreak} + 1`,
  }).where(eq(feeds.id, feedId))
}

const FETCH_INTERVAL = envInt("FETCH_INTERVAL", 900_000)
/**
 * 自适应抓取间隔（默认开）：内容久未更新的源降低轮询频率（15m→30m→1h→3h→6h），
 * 抓到新条目后立刻回到基础间隔。规则见 workers/fetch-schedule.ts。
 * 设为 0 恢复「每轮把全部 active 源都入队」的旧行为。
 */
const FETCH_ADAPTIVE = process.env.FETCH_ADAPTIVE !== "0"
/** 自适应降频的上限（默认 6 小时） */
const FETCH_MAX_INTERVAL = envInt("FETCH_MAX_INTERVAL", 6 * 60 * 60 * 1000)
/** 无验证器源提前一档降频（默认开；`FETCH_NO_VALIDATOR_SLOWDOWN=0` 关闭，见 fetch-schedule.ts） */
const FETCH_NO_VALIDATOR_SLOWDOWN = process.env.FETCH_NO_VALIDATOR_SLOWDOWN !== "0"
/** 调度错峰窗口：基础间隔的 10%（默认 90s），把同一 tick 到期的几百个源摊开入队 */
const FETCH_JITTER_SPAN_MS = Math.max(0, Math.floor(FETCH_INTERVAL * 0.1))
const fetchScheduleOptions: FetchScheduleOptions = {
  baseIntervalMs: FETCH_INTERVAL,
  maxIntervalMs: FETCH_MAX_INTERVAL,
  enabled: FETCH_ADAPTIVE,
  slowNonValidator: FETCH_NO_VALIDATOR_SLOWDOWN,
}

// 启动时把生效配置打一行：空串/非法值会被 envInt 回退成默认值，不打日志就只能翻代码猜
if (!isTestProcess) {
  console.log(
    `[Fetch] 配置: 基础间隔=${formatDuration(FETCH_INTERVAL)} 自适应=${FETCH_ADAPTIVE ? "开" : "关"}` +
    ` 降频上限=${formatDuration(FETCH_MAX_INTERVAL)} 并发=${FETCH_CONCURRENCY}` +
    ` 响应体上限=${Math.round(MAX_FEED_BYTES / 1048576)}MB/${Math.round(MAX_FEED_DECODED_BYTES / 1048576)}MB` +
    ` 图片压缩并发=${IMAGE_CONCURRENCY}` +
    ` 无验证器提前降频=${FETCH_NO_VALIDATOR_SLOWDOWN ? "开" : "关"} 错峰窗口=${formatDuration(FETCH_JITTER_SPAN_MS)}`,
  )
}

/** 由 RSS item 构造 EntryDoc */
function buildEntry(feedId: string, item: ParsedItem, guid: string, entryId: string): EntryDoc {
  return {
    _id: entryId,
    type: "entry",
    feedId,
    url: item.link ?? "",
    title: item.title ?? "",
    content: item.content ?? item.contentSnippet,
    description: item.summary ?? item.contentSnippet,
    guid,
    author: item.creator,
    publishedAt: item.pubDate ?? item.isoDate ?? new Date().toISOString(),
    insertedAt: new Date().toISOString(),
    categories: item.categories,
  }
}

/** 定时调度所有已知 feed 的抓取任务（跳过用户暂停的源；未到期的源见 fetch-schedule.ts） */
export async function scheduleFeedFetches() {
  const activeFeeds = await db.select({
    id: feeds.id,
    url: feeds.url,
    lastFetchedAt: feeds.lastFetchedAt,
    lastNewEntryAt: feeds.lastNewEntryAt,
    createdAt: feeds.createdAt,
    errorMessage: feeds.errorMessage,
    // 下面两列是自适应调度 / 错误退避的输入（见 fetch-schedule.ts）
    errorStreak: feeds.errorStreak,
    hasFetchValidators: feeds.hasFetchValidators,
    // 库名与图片策略随 job data 带给 worker，省掉稳态下每次抓取的 1–2 次 PG 查询
    couchDbName: feeds.couchDbName,
    ...feedImageColumns,
  })
    .from(feeds)
    .where(eq(feeds.status, "active"))

  // 自适应调度：只入队到期的源。间隔依据「距上次抓到新条目多久」，规则见 fetch-schedule.ts
  const now = Date.now()
  const dueFeeds = activeFeeds.filter(f => isFeedDue(f, fetchScheduleOptions, now))
  // 每 15 分钟一行，方便在日志里对照「本轮为什么少了这么多源」
  console.log(`[Fetch] 调度: ${dueFeeds.length}/${activeFeeds.length} 个源到期`)

  const jobs = dueFeeds.map(f => ({
    name: `fetch:${f.id}`,
    // jobId 固定为 feedId：同一 feed 已在排队/执行时跳过，避免抓取慢时任务堆积
    // （BullMQ 不允许 jobId 含冒号，故用纯 feedId）
    // 任务结果保留有限条数供看板（/admin/queues）查看；入队前会清掉已结束的旧 job，
    // 因此 jobId 不会因残留被 BullMQ 判定 duplicated 拒绝（曾导致 21 小时无抓取）
    opts: {
      jobId: f.id,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 50 },
      // 错峰：一个 tick 内到期的二三百个源不必同一秒开跑（延迟按 feedId 确定性哈希）
      delay: feedJitterMs(f.id, FETCH_JITTER_SPAN_MS),
    },
    data: {
      feedId: f.id,
      url: f.url,
      couchDbName: f.couchDbName,
      imageOptions: imageOptionsFromFeedRow(f),
    } satisfies FetchJobData,
  }))

  if (jobs.length > 0) {
    // 先清理各 feed 已结束（完成/失败）的旧 job，确保 jobId 可复用；
    // 执行中/排队中的 job 不动，避免打断在跑的任务
    await Promise.all(dueFeeds.map(f => removeFinishedJob(f.id)))
    await fetchQueue.addBulk(jobs)
  }
}

/** 清理 feed 已结束的旧 job（completed/failed）；active/waiting 等未结束的不动 */
async function removeFinishedJob(feedId: string) {
  const job = await fetchQueue.getJob(feedId)
  if (!job) return
  const state = await job.getState()
  if (state === "completed" || state === "failed") {
    await job.remove()
  }
}

/** 入队一次抓取（单 feed 场景）：先清掉队列里的旧 job 再入队，语义见 enqueue.ts */
export async function enqueueFetch(feedId: string, url: string) {
  await enqueueFetchJob(fetchQueue, feedId, url)
}

// 测试进程里也不挂调度定时器：`vitest --watch` 一挂几小时的话，它会按 FETCH_INTERVAL
// 往真实队列里灌 700+ 个任务（同样见 isTestProcess 注释）。
// 调度里的任何一步（PG/Redis）失败都不该变成 unhandled rejection 把进程带走；下一轮继续。
const fetchInterval = isTestProcess ? null : setInterval(() => {
  scheduleFeedFetches().catch((err) => {
    console.error("[Fetch] 调度失败（下一轮继续）:", err instanceof Error ? err.message : err)
  })
}, FETCH_INTERVAL)

// 定时维护：源库墓碑 GC + 休眠用户暂停（见 workers/maintenance.ts）
if (!isTestProcess) startTimelineMaintenance()

export async function shutdownWorkers() {
  if (fetchInterval) clearInterval(fetchInterval)
  shutdownTimelineMaintenance()
  // 测试进程里 worker 为 null（见 isTestProcess 注释）
  await worker?.close()
  await fetchQueue.close()
  // Bot 产出复制队列（独立于抓取队列，见 bot-sync.ts）
  await shutdownBotCopyWorkers()
  // 时间线聚合队列与本队列共用同一个 Redis 连接，必须在 quit 之前关掉
  await shutdownTimelineWorkers()
  await connection.quit()
}
