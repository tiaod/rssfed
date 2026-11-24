import crypto from "node:crypto"
import type { DocumentScope } from "nano"
import { createCouchDb, ensureBotDatabase, ensureTimelineDatabase } from "../couchdb/client"
import { feedDocId } from "../couchdb/doc-ids"
import { deriveFeedId } from "../couchdb/subscription-doc"
import {
  DEFAULT_SOURCE_RETENTION_ENTRIES,
  trimOwnerFeedToLatestN,
} from "../couchdb/retention"
import type { EntryDoc } from "../db"
import { parseFeedContent, type ParsedItem } from "../rss/parser"
import { getFeedContent } from "../rss/fetch-cache"
import { cacheEntryImages, cacheSingleImage, FEED_ICON_CACHE_VERSION, type EntryImageOptions } from "../rss/entry-images"
import { selectNewestItems } from "../workers/entry-selection"
import { buildFeedDoc, feedDocDisplayChanged, mergeFeedDocDisplay, shouldCacheFeedIcon, shouldWriteFeedDoc } from "../workers/feed-doc"
import { mergeSourceSchedule } from "./owner-schedule"

/**
 * 按 **owner** 抓取一个源并直接写进 owner 自己的库。
 *
 * ## 「owner」是什么
 *
 * 一个用户（库 `user-timeline_*`）或一个 Bot（库 `bot_*`）。两者互不相干、各抓各的：
 * 同一个源被 3 个用户订阅就是 3 个 job、3 次写库，但**只会有 1 次网络请求**
 * （靠 `rss/fetch-cache.ts` 的 URL 级缓存与进程内单飞）。
 *
 * ## 为什么不再有 feed 库
 *
 * 旧模型是「写进共享的 `feed_*` 库 → 再按需复制进各用户库」，好处是同源只抓一次、附件字节
 * 全局一致；代价是 707 个库 + 一整套扇出机器（复制器、水位、脏源判定、两侧各裁一遍）。
 * 实测那套机器服务的共享倍率只有 1.03×（707 源 / 133 订阅关系），
 * 所以这里的取舍是：**用 N 倍的写放大换掉整个扇出层**。
 *
 * ## 写库顺序（每一步都在失败时留下可自愈的状态）
 *
 * 1. 抓正文（缓存优先）→ 解析；
 * 2. 写 FeedDoc（只在展示字段真的变化时写 —— 它每多一版，每个浏览器都要收一次变更）；
 * 3. 批量判存在 → 只写真正新增的条目（含 AVIF 附件，一次性 multipart 写）；
 * 4. 裁掉超出保留条数的旧条目（`_purge`，不留墓碑）；
 * 5. 更新 `_local/schedule`（调度状态 + 本轮的 N）。
 *
 * 任一步抛错都由调用方记进 schedule 的 `errorStreak`，下一轮重试。**条目写入是幂等的**：
 * doc id 由 guid 哈希确定性派生，重跑只会命中"已存在"分支。
 */

export type OwnerRef =
  | { kind: "user", id: string }
  | { kind: "bot", id: string }

export interface FetchOwnerFeedInput {
  owner: OwnerRef
  /** 抓取地址（不可信输入，内部会过 SSRF 闸门） */
  url: string
  /** 源 id，必须等于 `deriveFeedId(url)`；不一致直接判脏（见 subscription-doc.ts） */
  feedId: string
  /** 展示名兜底（订阅文档里的 title；FeedDoc 用解析结果覆盖） */
  title?: string
  /** 用户暂停了这条订阅：不抓，直接返回 */
  paused?: boolean
  /** 该源在这个库里保留多少条（自适应算出；未算出时用全局默认） */
  retentionEntries?: number | null
  /** 图片策略（当前只有全局默认，留参数是为了 Bot 库将来能单独调） */
  imageOptions?: EntryImageOptions
  /** 当前时间注入（测试用） */
  now?: Date
}

export interface FetchOwnerFeedResult {
  owner: OwnerRef
  feedId: string
  /** 跳过（暂停/脏文档），不写库不抓网 */
  skipped?: "paused" | "feed-id-mismatch"
  /** 内容没变（304 或缓存命中且 ETag 相同），没写任何条目 */
  notModified?: boolean
  /** 本次真正写入的新条目数 */
  newEntries: number
  /** 本次裁掉的条目数 */
  trimmed: number
  /** 本次是否真的发了网络请求（false = 命中缓存） */
  networkFetch: boolean
  elapsedMs: number
}

/** 一次 `_all_docs` keys 查询的条数（CouchDB 对 POST body 有上限） */
const EXISTENCE_CHECK_CHUNK = 500

interface OwnerStore {
  dbName: string
  scope: DocumentScope<unknown>
}

async function resolveOwnerStore(owner: OwnerRef): Promise<OwnerStore> {
  const dbName = owner.kind === "user"
    ? await ensureTimelineDatabase(owner.id)
    : await ensureBotDatabase(owner.id)
  return { dbName, scope: createCouchDb(dbName) }
}

/** 候选条目（guid 已解析成确定性 doc id） */
interface EntryCandidate {
  item: ParsedItem
  guid: string
  entryId: string
}

/**
 * 批量判断候选条目在库里的状态：已存在（含活文档）→ 跳过；墓碑 → 跳过；从未出现 → 待写入。
 *
 * 逐条 `get` 在「一次列出上千条的源」上很贵（实测 1982 条 = 1982 次往返 6.2s），
 * 而 POST `_all_docs` 的 keys 查询一次能拿 500 条（0.22s）。
 *
 * 墓碑必须与「已存在」一样跳过：源里通常还列着被保留策略裁掉的老条目，写回去就是复活。
 */
async function partitionByExistence(scope: DocumentScope<unknown>, candidates: EntryCandidate[]) {
  const present = new Set<string>()
  const tombstoned = new Set<string>()
  for (let i = 0; i < candidates.length; i += EXISTENCE_CHECK_CHUNK) {
    const chunk = candidates.slice(i, i + EXISTENCE_CHECK_CHUNK)
    const res = await scope.fetch({ keys: chunk.map((c) => c.entryId) }) as {
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
      present.add(id)
    }
  }
  return { present, tombstoned }
}

/** 由 RSS item 构造 EntryDoc（`feedId` 前缀保持全局一致，与用户/Bot 无关） */
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

/**
 * 读 owner 库里的 FeedDoc（可能不存在）；只在 200 分支调用，用来合并展示字段。
 *
 * 读失败当作"没有旧文档"：最坏情况是把展示字段重写一遍，比整轮抓取失败好。
 */
async function readFeedDoc(scope: DocumentScope<unknown>, feedId: string): Promise<Record<string, unknown> | null> {
  try {
    return await scope.get(feedDocId(feedId)) as unknown as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 更新（或首次创建）FeedDoc，返回展示字段是否真的变了。
 *
 * 只写**展示字段**与图标缓存；抓取簿记一律在 `_local/schedule`。
 * 展示字段没变时**不写** —— 每多一版修订，这个库的每个浏览器都要收一次变更。
 */
async function updateFeedDoc(
  store: OwnerStore,
  feedId: string,
  url: string,
  parsed: ReturnType<typeof parseFeedContent>,
  existing: Record<string, unknown> | null,
): Promise<{ iconCached: boolean, displayChanged: boolean }> {
  const docId = feedDocId(feedId)
  const display = mergeFeedDocDisplay(existing, parsed, url)
  const doc = buildFeedDoc(existing, display, docId, new Date().toISOString())
  const displayChanged = feedDocDisplayChanged(existing, display)

  const imageUrl = display.image
  if (shouldCacheFeedIcon(existing, imageUrl, FEED_ICON_CACHE_VERSION) && imageUrl) {
    const cached = await cacheSingleImage(imageUrl)
    if (cached) {
      await store.scope.multipart.insert({ ...doc, imageCached: cached.image } as never,
        [{ name: cached.image.attachment, data: cached.data, content_type: "image/avif" }],
        { docName: docId, ...((existing as { _rev?: string })?._rev ? { rev: (existing as { _rev?: string })._rev } : {}) })
      return { iconCached: true, displayChanged: true }
    }
  }

  if (!shouldWriteFeedDoc(existing, display)) return { iconCached: false, displayChanged: false }
  await store.scope.insert(doc as never)
  return { iconCached: false, displayChanged }
}

/**
 * 抓取并写入一个 owner 的一个源。
 *
 * 调用方（抓取 worker）负责把结果记进 `_local/schedule`；本函数只做数据面的工作，
 * 这样它可以被单测直接驱动，不必起 Redis。
 */
export async function fetchOwnerFeed(input: FetchOwnerFeedInput): Promise<FetchOwnerFeedResult> {
  const startedAt = Date.now()
  const now = input.now ?? new Date()
  const { owner, url, feedId } = input

  if (input.paused) {
    return { owner, feedId, skipped: "paused", newEntries: 0, trimmed: 0, networkFetch: false, elapsedMs: 0 }
  }
  // feedId 与 url 不一致 = 订阅文档被写坏了（客户端可写）。按 url 重新派生但**拒绝写入**：
  // 否则条目会以错误的 id 前缀落库，下次按正确 id 派生时读不到、永远重复写。
  if (deriveFeedId(url) !== feedId) {
    return { owner, feedId, skipped: "feed-id-mismatch", newEntries: 0, trimmed: 0, networkFetch: false, elapsedMs: 0 }
  }

  const store = await resolveOwnerStore(owner)

  // ① 抓正文（缓存优先，内部过 SSRF 闸门与重定向逐跳校验）
  // 缓存命中与网络命中都解析：解析是毫秒级，而"这轮有没有新条目"必须靠解析结果判断
  const fetched = await getFeedContent(url)
  const parsed = parseFeedContent(fetched.content)

  // ② FeedDoc：只在展示字段变化时写
  const existingDoc = await readFeedDoc(store.scope, feedId)
  const { iconCached, displayChanged } = await updateFeedDoc(store, feedId, url, parsed, existingDoc)

  // ③ 只处理保留窗口内的最新 N 条：超出 N 的条目下一刻就会被裁掉，先写再删纯属写放大
  const retention = normalizeRetention(input.retentionEntries)
  const candidates: EntryCandidate[] = []
  const deduped = new Set<string>()
  for (const item of selectNewestItems(parsed.items ?? [], retention)) {
    const guid = item.guid ?? item.link ?? item.title ?? ""
    const entryId = `entry:${feedId}:${crypto.createHash("sha256").update(guid).digest("hex").slice(0, 12)}`
    // 同一批里 guid 重复的条目只保留第一条：批量判存在后它们都会被当成新条目，写第二次会 409
    if (deduped.has(entryId)) continue
    deduped.add(entryId)
    candidates.push({ item, guid, entryId })
  }
  const { present, tombstoned } = await partitionByExistence(store.scope, candidates)

  const newEntries: EntryDoc[] = []
  for (const { item, guid, entryId } of candidates) {
    if (present.has(entryId) || tombstoned.has(entryId)) continue
    const entry = buildEntry(feedId, item, guid, entryId)
    // 图片缓存失败不阻塞抓取，回退为无图条目（前端保留原 URL 直链）
    try {
      const { attachments, images } = await cacheEntryImages(entry.content, entry.url, item.coverUrl, input.imageOptions)
      if (images.length > 0) {
        // nano 的 multipart.insert 需在 params 中显式传入 docName
        await store.scope.multipart.insert({ ...entry, images } as never, attachments, { docName: entryId })
        newEntries.push(entry)
        continue
      }
    } catch (err) {
      console.warn(`[EntryImages] 图片缓存失败，回退原始条目 ${entryId}:`, err)
    }
    await store.scope.insert(entry as never)
    newEntries.push(entry)
  }

  // ④ 裁剪到最新 N 条（只裁这一个源；`_purge` 不留墓碑）
  const trimmed = await trimOwnerFeedToLatestN(store.dbName, feedId, retention)

  const notModified = newEntries.length === 0 && !iconCached && !displayChanged
  return {
    owner,
    feedId,
    ...(notModified ? { notModified: true } : {}),
    newEntries: newEntries.length,
    trimmed,
    networkFetch: !fetched.fromCache,
    elapsedMs: Date.now() - startedAt,
  }
}

/** 保留条数的合法化：缺省/非法值回退全局默认 */
export function normalizeRetention(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return DEFAULT_SOURCE_RETENTION_ENTRIES
  return Math.floor(value)
}

/**
 * 抓取成功/失败后更新该源的调度状态（供调度器判断到期与退避）。
 *
 * 单独拆出来是因为失败路径也要记（`errorStreak` 是退避的唯一输入），
 * 而失败时数据面什么都没写成，不能只依赖 `fetchOwnerFeed` 的返回值。
 */
export async function recordFetchOutcome(
  dbName: string,
  feedId: string,
  outcome: { ok: true, newEntries: number, hasValidators: boolean, retentionEntries?: number | null }
    | { ok: false },
  now: Date = new Date(),
): Promise<void> {
  if (outcome.ok) {
    await mergeSourceSchedule(dbName, feedId, {
      lastFetchedAt: now.toISOString(),
      ...(outcome.newEntries > 0 ? { lastNewEntryAt: now.toISOString() } : {}),
      errorStreak: 0,
      hasValidators: outcome.hasValidators,
      ...(outcome.retentionEntries !== undefined ? { retentionEntries: outcome.retentionEntries } : {}),
    })
    return
  }
  // 失败也算"抓过一次"：否则坏源会在同一轮里被反复重试，把队列堵死。
  // errorStreak 由调用方读出来 +1 后传进来（这里不知道上一次的值）。
  await mergeSourceSchedule(dbName, feedId, {
    lastFetchedAt: now.toISOString(),
    lastErrorAt: now.toISOString(),
  })
}
