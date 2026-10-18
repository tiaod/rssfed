import { Worker, Queue } from "bullmq"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { ensureFeedDatabase, ensureBotDatabase, createCouchDb } from "../couchdb/client"
import { createTrimDb, trimSourceToLatestN } from "../couchdb/retention"
import { feedDocId } from "../couchdb/doc-ids"
import { isDeletedDocError } from "../couchdb/doc-errors"
import { fetchParsedFeed, formatFeedError, type FeedValidators, type ParsedFeed, type ParsedItem } from "../rss/parser"
import { cacheEntryImages, cacheSingleImage, FEED_ICON_CACHE_VERSION, type EntryImageOptions } from "../rss/entry-images"
import { db, feeds, botFeeds, bots as botsTable, type EntryDoc } from "../db"
import { connection, createWorkerConnection } from "./connection"
import { isFeedDue, type FetchScheduleOptions } from "./fetch-schedule"
import { enqueueFetchJob } from "./enqueue"
import { buildFeedRegistryUpdate } from "./feed-registry"
import { notifyTimelineStale, shutdownTimelineWorkers } from "./timeline"

export const fetchQueue = new Queue("rss-fetch", { connection })

type FeedDb = ReturnType<typeof createCouchDb>

/**
 * 抓取并发度：单个源最慢要拖满 10s（没有代理时直连被墙站点必然超时），串行跑 700+ 个源
 * 会让队列永远追不上 15 分钟的调度间隔（2026-10-10 实测积压 600+，一条 refetch 要排十几分钟）。
 * 默认 4，可用 FETCH_CONCURRENCY 调整。
 */
const FETCH_CONCURRENCY = Math.max(1, parseInt(process.env.FETCH_CONCURRENCY ?? "4") || 4)

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
  const { feedId, url } = job.data

  try {
    const feedDbName = await ensureFeedDatabase(feedId)
    const feedDb = createCouchDb(feedDbName)

    // 先读 FeedDoc：拿上次响应头里的 ETag/Last-Modified（条件请求），
    // 顺带省掉 updateFeedDoc 里再 get 一次。
    const previous = await readFeedDoc(feedDb, feedId)
    const fetched = await fetchParsedFeed(url, previous.validators)

    // 304：内容没变。只刷抓取时间、清掉上一轮错误，不写条目、不裁剪、不通知 Bot/时间线。
    // 这是省流量的关键路径 —— 绝大多数轮次都会走到这里，一个正文字节都不用传。
    if (fetched.notModified) {
      await markFeedNotModified(feedDb, feedId, previous.doc)
      return { feedId, notModified: true, newEntries: 0, trimmed: 0, totalItems: 0 }
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
    const newEntries = await insertNewEntries(feedDb, feedId, parsed.items ?? [])
    // 源库保留策略：每条源只留最新 N 条 —— 整个保留链路的唯一权威
    // （见 docs/notes/aggregation/source-side-retention-plan.md）。
    // 超限才动数据；拿不到边界时一条都不删。compact 不放在这里：删除只产生墓碑，
    // 附件字节由 CouchDB 自身的 [compactions] 或定时 compact 回收。
    const trim = await trimSourceToLatestN(createTrimDb(feedDbName), { compact: false })
    // 两个时间戳语义不同，别混：
    //   lastNewEntryAt → "抓到新内容"（前端"最后更新"用）
    //   lastChangedAt  → "源内容变了"（脏源判定用；**裁剪删除也算**，否则只删不增的源永不触发同步）
    const now = new Date()
    const patch: { lastNewEntryAt?: Date, lastChangedAt?: Date } = {}
    if (newEntries.length > 0 || iconCached) patch.lastNewEntryAt = now
    if (newEntries.length > 0 || iconCached || trim.deleted > 0) patch.lastChangedAt = now
    if (Object.keys(patch).length > 0) {
      await db.update(feeds).set(patch).where(eq(feeds.id, feedId))
    }
    // 无论有无新条目都同步相关 Bot：FeedDoc 元信息需在无新条目时也能校正
    await notifyRelatedBots(feedId, newEntries)

    // 有新条目**或裁掉了条目** → 通知各用户的时间线聚合尽快跑一轮（带节流：一轮抓取里几十个源
    // 都有变化时只通知一次）。聚合本身是增量的，安静时每个用户只花一条 SQL。
    if (newEntries.length > 0 || trim.deleted > 0) {
      void notifyTimelineStale(feedId).catch(() => {})
    }

    return { feedId, newEntries: newEntries.length, trimmed: trim.deleted, totalItems: parsed.items?.length ?? 0 }
  } catch (err) {
    // 抓取失败，更新 feed 注册表的 errorMessage
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
 */
async function markFeedNotModified(feedDb: FeedDb, feedId: string, existing: any): Promise<void> {
  const now = new Date().toISOString()
  if (existing) {
    try {
      // errorMessage: undefined 会被 nano 的 JSON.stringify 丢掉，等效于从文档里清掉该字段
      await feedDb.insert({ ...existing, lastFetchedAt: now, errorMessage: undefined } as any)
    } catch (err) {
      // FeedDoc 写失败不影响这一轮：下一轮会带同样的验证器回来，304 之后还会再写一次
      console.warn(`[Fetch] 304 后更新 FeedDoc 失败 ${feedId}:`, (err as any)?.message ?? err)
    }
  }
  await db.update(feeds).set({ lastFetchedAt: new Date(), errorMessage: null }).where(eq(feeds.id, feedId))
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

/** 写入新条目到 per-feed CouchDB 库，返回本次新增的条目列表 */
async function insertNewEntries(feedDb: FeedDb, feedId: string, items: ParsedItem[]) {
  const newEntries: EntryDoc[] = []
  // 读取该 feed 的 per-feed 图片缓存策略（管理员可覆盖全局默认，未设置则走全局默认）
  const imageOptions = await resolveFeedImageOptions(feedId)
  // 本次抓取的图片缓存汇总：逐张打日志会把 600+ 源的日志刷爆，所以循环结束后聚合成一行
  const imgAgg = {
    candidates: 0, skippedLimit: 0, skippedBudget: 0, cached: 0, failed: 0, bytes: 0,
    reasons: {} as Record<string, number>,
  }
  for (const item of items) {
    const guid = item.guid ?? item.link ?? item.title ?? ""
    const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`

    // 已存在则跳过
    try {
      await feedDb.get(entryId)
      continue
    } catch (err) {
      // 已删除（保留策略裁掉的旧条目）：订阅源通常还会列着它，但**不能写回**。
      // 否则每轮抓取都是一次「复活 → 裁剪 → 再复活」：实测单个源里同一条 entry 攒到 68 个修订、
      // 整个库 1600+ 墓碑；而且 newEntries 非空会把 lastChangedAt 每轮刷成"有变化"，
      // 触发无意义的聚合复制。墓碑在这里的语义就是"已删除，别再回来"。
      if (isDeletedDocError(err)) continue
      // 从未存在：正常新条目，继续写入
    }

    const entry = buildEntry(feedId, item, guid, entryId)
    // 下载并压缩正文图片为 AVIF 附件，与条目一次写入（multipart）；
    // 协议封面（media:thumbnail/图片 enclosure）优先作为封面，正文图回退；
    // 图片缓存失败不阻塞抓取，回退为无图条目（前端保留原 URL 直链）
    try {
      const { attachments, images, stats } = await cacheEntryImages(entry.content, entry.url, item.coverUrl, imageOptions)
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

/** 从 feeds 表读取该 feed 的 per-feed 图片缓存配置（仅返回设置过的字段，其余走全局默认） */
async function resolveFeedImageOptions(feedId: string): Promise<EntryImageOptions> {
  try {
    const [feed] = await db.select({
      cacheImages: feeds.cacheImages,
      maxImageCount: feeds.maxImageCount,
      maxEntryImageBytes: feeds.maxEntryImageBytes,
      maxImageWidth: feeds.maxImageWidth,
      avifQuality: feeds.avifQuality,
      maxSourceImageBytes: feeds.maxSourceImageBytes,
    }).from(feeds).where(eq(feeds.id, feedId)).limit(1)
    if (!feed) return {}
    return {
      cacheAll: feed.cacheImages ?? false,
      maxImageCount: feed.maxImageCount ?? undefined,
      maxEntryImageBytes: feed.maxEntryImageBytes ?? undefined,
      maxImageWidth: feed.maxImageWidth ?? undefined,
      avifQuality: feed.avifQuality ?? undefined,
      maxSourceImageBytes: feed.maxSourceImageBytes ?? undefined,
    }
  } catch {
    // 读取配置失败不影响抓取，走全局默认
    return {}
  }
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

/** 将新条目以「原文镜像」写入引用了该 feed 的 Bot 的产出库（_id 确定性天然幂等） */
async function notifyRelatedBots(feedId: string, newEntries: EntryDoc[]) {
  const relatedBots = await db.select({
    id: botFeeds.botId,
    name: botsTable.name,
    avatarUrl: botsTable.avatarUrl,
  })
    .from(botFeeds)
    .innerJoin(botsTable, eq(botsTable.id, botFeeds.botId))
    .where(eq(botFeeds.feedId, feedId))
  if (relatedBots.length === 0) return
  console.log(`[Bot] notifyRelatedBots: ${relatedBots.length} bot(s) for feed ${feedId}, newEntries=${newEntries.length}`)

  // 从 feed 库读 entry（含图片附件二进制）复制到各 bot 产出库，避免重复下载压缩图片
  const feedDb = createCouchDb(await ensureFeedDatabase(feedId))
  for (const bot of relatedBots) {
    const botDb = createCouchDb(await ensureBotDatabase(bot.id))
    await ensureBotFeedDoc(botDb, bot.id, bot.name, bot.avatarUrl)
    let published = 0
    for (const entry of newEntries) {
      // 产出 doc _id：entry:bot:{botId}:{hash12}，与 feed 库 entry 同源 hash，冲突即已写入
      const outputId = `entry:bot:${bot.id}:${entry._id.replace(/^entry:[^:]+:/, "")}`
      try {
        await botDb.get(outputId)
        continue // 已存在，跳过
      } catch {
        // 不存在，继续写入
      }
      try {
        // 附件随 doc 读取（base64）后 multipart 写入，产出 doc 离线也能看图
        const doc = await feedDb.get(entry._id, { attachments: true }) as any
        const { _rev: _omit, _attachments: _omitAtt, ...rest } = doc
        const outputDoc = { ...rest, _id: outputId, feedId: `bot:${bot.id}` }
        if (doc._attachments) {
          const attachments = Object.entries(doc._attachments).map(([name, att]: [string, any]) => ({
            name,
            data: Buffer.from(att.data, "base64"),
            content_type: att.content_type,
          }))
          await botDb.multipart.insert(outputDoc, attachments, { docName: outputId })
        } else {
          await botDb.insert(outputDoc)
        }
        published++
      } catch (err) {
        // 写入失败（含并发 409 冲突）不阻塞抓取，记日志继续
        console.warn(`[Bot] 产出写入失败 ${bot.id}/${entry._id}:`, (err as any)?.message ?? err)
      }
    }
    if (published > 0) {
      // touch 最后产出时间，供前端增量同步判断
      await db.update(botsTable).set({ lastNewEntryAt: new Date() }).where(eq(botsTable.id, bot.id))
    }
  }
}

/** 确保 bot 产出库存在 FeedDoc（_id 为虚拟 feed id `bot:{botId}`），供时间线补全 bot 名字/头像 */
async function ensureBotFeedDoc(botDb: FeedDb, botId: string, name: string, avatarUrl: string | null) {
  const docId = `bot:${botId}`
  try {
    const existing = await botDb.get(docId) as any
    // 名字/头像变化时同步更新（每次抓取都会校正）
    if (existing.title !== name || existing.image !== avatarUrl) {
      await botDb.insert({ ...existing, title: name, image: avatarUrl ?? undefined } as any)
    }
  } catch {
    await botDb.insert({
      _id: docId,
      type: "feed",
      url: "",
      title: name,
      image: avatarUrl ?? undefined,
      lastFetchedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as any)
  }
}

/** 抓取失败时记录错误到 feed 注册表 */
async function markFeedError(feedId: string, url: string, err: unknown) {
  await db.update(feeds).set({
    errorMessage: formatFeedError(url, err),
    lastFetchedAt: new Date(),
  }).where(eq(feeds.id, feedId))
}

const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL ?? "900000")
/**
 * 自适应抓取间隔（默认开）：内容久未更新的源降低轮询频率（15m→30m→1h→3h→6h），
 * 抓到新条目后立刻回到基础间隔。规则见 workers/fetch-schedule.ts。
 * 设为 0 恢复「每轮把全部 active 源都入队」的旧行为。
 */
const FETCH_ADAPTIVE = process.env.FETCH_ADAPTIVE !== "0"
/** 自适应降频的上限（默认 6 小时） */
const FETCH_MAX_INTERVAL = parseInt(process.env.FETCH_MAX_INTERVAL ?? String(6 * 60 * 60 * 1000))
const fetchScheduleOptions: FetchScheduleOptions = {
  baseIntervalMs: FETCH_INTERVAL,
  maxIntervalMs: FETCH_MAX_INTERVAL,
  enabled: FETCH_ADAPTIVE,
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
    opts: { jobId: f.id, removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } },
    data: { feedId: f.id, url: f.url },
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
// 往真实队列里灌 700+ 个任务（同样见 isTestProcess 注释）
const fetchInterval = isTestProcess ? null : setInterval(scheduleFeedFetches, FETCH_INTERVAL)

export async function shutdownWorkers() {
  if (fetchInterval) clearInterval(fetchInterval)
  // 测试进程里 worker 为 null（见 isTestProcess 注释）
  await worker?.close()
  await fetchQueue.close()
  // 时间线聚合队列与本队列共用同一个 Redis 连接，必须在 quit 之前关掉
  await shutdownTimelineWorkers()
  await connection.quit()
}
