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
import { buildFeedRegistryUpdate, validatorsFromFeedRow, type FeedFetchMeta } from "./feed-registry"
import { buildFeedDoc, feedDocDisplayChanged, mergeFeedDocDisplay, shouldCacheFeedIcon, shouldWriteFeedDoc } from "./feed-doc"
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
 * 自适应保留条数开关。关掉后**所有源回退固定 50 条**（已裁掉的历史不会恢复，只影响之后的
 * 写入/裁剪）；保留条数的计算任务也由同一个环境变量停掉（见 workers/maintenance.ts）。
 */
const RETENTION_ADAPTIVE_ENABLED = process.env.FEED_RETENTION_ADAPTIVE !== "0"

/**
 * 抓取 job 的 payload。
 *
 * `couchDbName` / `imageOptions` / `validators` 由调度器在同一个 SQL 里带出来：稳态下
 * worker 可以少查 1–2 次 PostgreSQL（705 源 × 每轮 1 次已经不小）。手工「立即抓取」/
 * 首抓 / 老 Redis 里残留的 job 不带这些，worker 回退到原来的查询路径。
 */
interface FetchJobData {
  feedId: string
  url: string
  couchDbName?: string | null
  imageOptions?: EntryImageOptions
  /** 条件请求验证器：从 `feeds` 表带出来（不再存在 FeedDoc 里，见 workers/feed-doc.ts） */
  validators?: FeedValidators
  /** 自适应保留条数：从 `feeds.retention_entries` 带出来（见 services/feed-retention.ts） */
  retentionEntries?: number | null
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
  const { feedId, url, couchDbName, imageOptions, validators: jobValidators, retentionEntries: jobRetentionEntries } = job.data as FetchJobData

  try {
    // 调度器已带出库名时跳过「按 feedId 查 PG」（稳态路径）
    const feedDbName = await ensureFeedDatabase(feedId, couchDbName)
    const feedDb = createCouchDb(feedDbName)

    // 自适应保留条数（源活跃度算出，见 services/feed-retention.ts）：稳态由调度器随 job 带过来，
    // 手工「立即抓取」/首抓/老 job 没有时回退一次查询。
    const retentionEntries = RETENTION_ADAPTIVE_ENABLED
      ? (jobRetentionEntries ?? await loadFeedRetentionEntries(feedId))
      : DEFAULT_SOURCE_RETENTION_ENTRIES

    // 条件请求验证器只在 PostgreSQL `feeds` 表（不写进 FeedDoc，理由见 workers/feed-doc.ts）。
    // 稳态由调度器随 job 带过来；手工「立即抓取」/首抓/老 job 没有时回退一次查询。
    const validators = jobValidators ?? await loadFeedValidators(feedId)
    const fetched = await fetchParsedFeed(url, validators)

    // 304：内容没变。只刷 PG 里的抓取时间/错误状态，**不写 CouchDB**（不产生新的 FeedDoc 修订）。
    // 这是省流量的关键路径 —— 绝大多数轮次都会走到这里，一个正文字节都不用传。
    // （唯一的例外是下面的补裁剪：上一轮没裁剪完时它仍可能产生删除并通知时间线。）
    if (fetched.notModified) {
      await markFeedNotModified(feedId)
      // 自愈：上一轮可能「写入成功但裁剪没跑完/失败」，而 304 之后不再走写入分支，
      // 那条源会永远停在超限状态。这里补一次裁剪 —— 稳态下 total<=N，只是一次视图查询（几毫秒）。
      const trim = await trimSourceToLatestN(createTrimDb(feedDbName), { n: retentionEntries, compact: false })
      if (trim.deleted > 0) {
        // 删除同样算「源内容变了」，否则只删不增的源永远触发不了用户库同步
        await db.update(feeds).set({ lastChangedAt: new Date() }).where(eq(feeds.id, feedId))
        void notifyTimelineStale(feedId).catch(() => {})
      }
      return { feedId, notModified: true, newEntries: 0, trimmed: trim.deleted, totalItems: 0 }
    }

    const parsed = fetched.feed

    // 200 才需要读 FeedDoc（合并展示字段）；304 分支一次 CouchDB 读都不用发。
    const existingDoc = await readFeedDoc(feedDb, feedId)

    // 依次更新 FeedDoc 元数据、PostgreSQL 注册表，再写入新条目并通知相关 Bot
    const { iconCached, displayChanged } = await updateFeedDoc(feedDb, feedId, url, parsed, existingDoc)
    // 本次响应没给验证器时保留上一轮能用的（validatorUrl 必须与验证器一起更新，
    // 否则改了重定向目标后会拿旧资源的 ETag 去问新地址 —— 见 rss/parser.ts 的说明）。
    await updateFeedRegistry(feedId, url, parsed, {
      validatorUrl: fetched.validatorUrl ?? validators.url,
      etag: fetched.etag ?? validators.etag,
      lastModified: fetched.lastModified ?? validators.lastModified,
    })
    const newEntries = await insertNewEntries(feedDb, feedId, parsed.items ?? [], imageOptions, retentionEntries)
    // 源库保留策略：每条源只留最新 N 条 —— 整个保留链路的唯一权威
    // （N 由源活跃度自适应，见 services/feed-retention.ts）。
    // 超限才动数据；拿不到边界时一条都不删。compact 不放在这里：删除只产生墓碑，
    // 附件字节由 CouchDB 的自动压缩（smoosh 的 ratio 通道，阈值见 deploy/couchdb-replicator.ini）回收。
    const trim = await trimSourceToLatestN(createTrimDb(feedDbName), { n: retentionEntries, compact: false })
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
    // FeedDoc 展示字段（标题/简介/站点/封面）变了也要触发一次同步，否则只改元信息、
    // 不出新条目的源在用户库里永远看不到更新（以前靠"每轮都写 FeedDoc"掩盖了这一点）。
    // 只清理遗留簿记的那种写入不算（客户端看不到变化，没必要叫醒每个订阅者）。
    if (newEntries.length > 0 || iconCached || displayChanged || trim.deleted > 0) patch.lastChangedAt = now
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
 * 从源库读出 FeedDoc（可能不存在）；只在 200 分支调用，用来合并展示字段。
 *
 * 抓取簿记（验证器/最后抓取时间/错误）不再从这份文档读 —— 那是 PostgreSQL `feeds` 表的事，
 * 这份文档只装会复制进用户聚合库的展示字段（见 workers/feed-doc.ts）。
 */
async function readFeedDoc(feedDb: FeedDb, feedId: string): Promise<any | null> {
  try {
    return await feedDb.get(feedDocId(feedId)) as any
  } catch {
    // 首次抓取（FeedDoc 还没建）或读取失败：当作没有旧文档，走首次插入
    return null
  }
}

/**
 * 从 PostgreSQL 读条件请求验证器（调度器没随 job 带过来时的回退路径）。
 *
 * 读失败不抛：退化成「没有验证器」只会多一次全量下载，不该让整轮抓取失败。
 */
async function loadFeedValidators(feedId: string): Promise<FeedValidators> {
  try {
    const [row] = await db.select({
      fetchValidatorUrl: feeds.fetchValidatorUrl,
      fetchEtag: feeds.fetchEtag,
      fetchLastModified: feeds.fetchLastModified,
    }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
    return validatorsFromFeedRow(row)
  } catch {
    return {}
  }
}

/** 当前该源的自适应保留条数（job data 没带时的回退路径；没算过就回退全局默认） */
async function loadFeedRetentionEntries(feedId: string): Promise<number> {
  try {
    const [row] = await db.select({ retentionEntries: feeds.retentionEntries })
      .from(feeds).where(eq(feeds.id, feedId)).limit(1)
    return row?.retentionEntries ?? DEFAULT_SOURCE_RETENTION_ENTRIES
  } catch {
    return DEFAULT_SOURCE_RETENTION_ENTRIES
  }
}

/**
 * 304 之后只刷新 PostgreSQL 的抓取状态：**不碰 CouchDB**。
 *
 * 以前这里会按 1 小时粒度重写一次 FeedDoc 的 `lastFetchedAt`，那份修订同样会复制进每个
 * 用户库。现在 FeedDoc 只装展示字段，抓取时间/错误信息以 `feeds` 表为唯一权威。
 */
async function markFeedNotModified(feedId: string): Promise<void> {
  await db.update(feeds).set({
    lastFetchedAt: new Date(),
    errorMessage: null,
    // 304 说明条件请求验证器可用：错误清零，并标记为「有验证器」（调度器不提前降频）
    errorStreak: 0,
    hasFetchValidators: true,
  }).where(eq(feeds.id, feedId))
}

/**
 * 更新（或首次创建）CouchDB 中的 FeedDoc 元数据。
 *
 * 只写**展示字段**（title/description/siteUrl/image）与图标缓存；抓取簿记一律留在 PG
 * （理由见 workers/feed-doc.ts 顶部注释）。展示字段没变、文档里也没有遗留簿记时**不写**，
 * 避免每轮抓取都产生一个会被复制进每个用户库的修订。
 *
 * @returns iconCached     本次是否新缓存了图标（要触发同步，客户端才能拉到附件）
 * @returns displayChanged 展示字段是否真的变了（决定要不要 bump lastChangedAt 叫醒订阅者）
 */
async function updateFeedDoc(
  feedDb: FeedDb,
  feedId: string,
  url: string,
  parsed: ParsedFeed,
  existing: any | null,
): Promise<{ iconCached: boolean, displayChanged: boolean }> {
  // 这个函数里所有 CouchDB 文档名（get / insert / multipart 附件）都必须用 docId：
  // 下划线开头的 feedId 直接当文档 id 会被 CouchDB 拒（见 couchdb/doc-ids.ts）。
  const docId = feedDocId(feedId)
  const display = mergeFeedDocDisplay(existing, parsed, url)
  const doc = buildFeedDoc(existing, display, docId, new Date().toISOString())
  const displayChanged = feedDocDisplayChanged(existing, display)

  // feed 图标缓存：URL 变化、或压缩参数版本升级（见 FEED_ICON_CACHE_VERSION）时
  // 重新下载压缩为 AVIF 附件；失败静默跳过（下一轮会再试）。
  const imageUrl = display.image
  if (shouldCacheFeedIcon(existing, imageUrl, FEED_ICON_CACHE_VERSION) && imageUrl) {
    const cached = await cacheSingleImage(imageUrl)
    if (cached) {
      await feedDb.multipart.insert({ ...doc, imageCached: cached.image } as any,
        [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }],
        { docName: docId, ...(existing?._rev ? { rev: existing._rev } : {}) })
      return { iconCached: true, displayChanged: true }
    }
  }

  if (!shouldWriteFeedDoc(existing, display)) return { iconCached: false, displayChanged: false }
  await feedDb.insert(doc as any)
  return { iconCached: false, displayChanged }
}

/** 更新 PostgreSQL feed 注册表（含条件请求验证器） */
async function updateFeedRegistry(
  feedId: string,
  url: string,
  parsed: ParsedFeed,
  fetchMeta: FeedFetchMeta,
) {
  await db.update(feeds).set(buildFeedRegistryUpdate(url, parsed, fetchMeta)).where(eq(feeds.id, feedId))
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
  imageOptions: EntryImageOptions | undefined,
  retentionEntries: number,
) {
  const newEntries: EntryDoc[] = []
  // ① 只处理保留窗口内的最新 N 条：超出 N 的条目下一刻就会被裁掉，先写再删纯属写放大
  //   （首次订阅历史型源时尤其明显：实测一个源列 1982 条 → 1982 次写 + 1932 个墓碑）。
  const candidates: EntryCandidate[] = []
  const deduped = new Set<string>()
  for (const item of selectNewestItems(items, retentionEntries)) {
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
    // 自适应保留条数（每日任务算出，见 services/feed-retention.ts）
    retentionEntries: feeds.retentionEntries,
    // 条件请求验证器随 job 带给 worker（它们只存在 PG，不再写进 FeedDoc）
    fetchValidatorUrl: feeds.fetchValidatorUrl,
    fetchEtag: feeds.fetchEtag,
    fetchLastModified: feeds.fetchLastModified,
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
      validators: validatorsFromFeedRow(f),
      retentionEntries: f.retentionEntries,
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
