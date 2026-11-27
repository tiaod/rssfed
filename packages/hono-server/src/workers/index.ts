import { Worker, Queue, type Job } from "bullmq"
import { eq } from "drizzle-orm"
import { createCouchDb, ensureBotDatabase, ensureTimelineDatabase } from "../couchdb/client"
import { db, botFeeds, user } from "../db"
import { connection, createWorkerConnection } from "./connection"
import { envInt } from "../env"
import { fetchOwnerFeed, normalizeRetention } from "../services/owner-fetch"
import { mergeSourceSchedule, readSchedule } from "../services/owner-schedule"
import { isFeedDue, feedJitterMs, type FetchScheduleOptions } from "./fetch-schedule"
import { parseSubscription, deriveFeedId } from "../couchdb/subscription-doc"
import { collectScheduleTargets } from "../services/owner-platform"
import { listBotSubscribers, syncBotEntriesToUser } from "../services/bot-subscription-sync"
import { recordFetchRound } from "../services/timeline-events"
import { createFetchRoundBook, roundKey } from "./fetch-round"

/**
 * 抓取队列 —— 一个 job = **(owner, 源)** 的一次抓取。
 *
 * ## 与旧模型的根本差别
 *
 * 旧 job 是「一个全局源」：写进共享的 `feed_*` 库，再由另一套队列按需复制进各用户库。
 * 新 job 是「某个用户或某个 Bot 的一个源」：直接写进它自己的库，**没有中间库、没有复制**。
 *
 * 代价是同一个源被 N 个 owner 订阅就抓 N 次；省下的是整套扇出机器（复制器、水位、脏源判定、
 * 两侧各裁一遍、孤儿源清扫）。实测那套机器服务的共享倍率只有 1.03×（707 源 / 133 订阅关系），
 * 所以这笔交换是划算的 —— 而重复的网络请求由 `rss/fetch-cache.ts` 的 URL 级缓存 + 单飞摊平。
 *
 * ## jobId
 *
 * `{ownerKind}:{ownerId}@{feedId}` 的变体，**不能含冒号**（BullMQ 限制），
 * 所以两侧都做 URL 编码。同一个 (owner, 源) 同时只有一个 job：定时调度、手动刷新、
 * 订阅后首抓三方同时打过来也只会跑一次。
 */

export const fetchQueue = new Queue("rss-fetch", { connection })

/**
 * 本轮记账簿（进程内，见 ./fetch-round.ts）。
 *
 * 放在模块级是因为调度器与 worker 都在这个文件里、都只用这一份：job 靠令牌认领自己那一轮。
 * 单测不碰它 —— 测试进程里 worker 为 null，没有人会写进来。
 */
const fetchRounds = createFetchRoundBook()

/**
 * 抓取并发度：单个源最慢要拖满 10s（没有代理时直连被墙站点必然超时），串行跑几百个 job
 * 会让队列永远追不上调度间隔（实测积压 600+，一条 refetch 要排十几分钟）。
 * 默认 4，可用 FETCH_CONCURRENCY 调整。
 */
const FETCH_CONCURRENCY = envInt("FETCH_CONCURRENCY", 4)

export type FetchOwnerJob =
  | { kind: "user", id: string }
  | { kind: "bot", id: string }

export interface FetchJobData {
  owner: FetchOwnerJob
  feedId: string
  url: string
  title?: string
  /** 绕开抓取缓存（"立即抓取"按钮用；调度产生的 job 不传） */
  bypassCache?: boolean
  /**
   * 所属调度轮次的令牌（见 ./fetch-round.ts）。
   *
   * 只有定时调度会带：手动同步 / 订阅后首抓是用户触发的，不该混进「这一轮抓取了什么」。
   * **不参与 jobId** —— 带上它会让同一 (owner, 源) 在每轮都变成不同的 job，去重就失效了。
   */
  roundToken?: string
}

/** jobId：BullMQ 不允许冒号，两侧都编码 */
export function fetchJobId(owner: FetchOwnerJob, feedId: string): string {
  return `${owner.kind}_${encodeURIComponent(owner.id)}@${encodeURIComponent(feedId)}`
}

/**
 * 测试进程里不启动 worker。
 *
 * mcp.test.ts / health.test.ts 会 `import "../app"`，把本模块整个拉进测试进程；模块顶层的
 * `new Worker(...)` 会让测试跑起来就去消费**真实 Redis 队列** —— 抢走线上待抓任务，
 * 而且测试进程没有加载 .env。2026-10-10 跑一次全量测试就吃掉 2 个刚入队的 job。
 */
const isTestProcess = process.env.VITEST === "true" || process.env.NODE_ENV === "test"

export const worker: Worker | null = isTestProcess ? null : new Worker("rss-fetch", async (job: Job<FetchJobData>) => {
  return await runFetchJob(job)
}, { connection: createWorkerConnection(), concurrency: FETCH_CONCURRENCY })

/**
 * 一个 job 的完整流程：读调度状态 → 抓取写库 → 回写调度状态。
 *
 * 失败路径**也必须回写**（记 `errorStreak` 与 `lastErrorAt`）：否则坏源会被下一轮调度
 * 立刻再判成到期、反复重试，把队列堵死。
 */
export async function runFetchJob(job: Job<FetchJobData>): Promise<{
  owner: FetchOwnerJob, feedId: string, newEntries: number, trimmed: number, networkFetch: boolean, skipped?: string
}> {
  const { owner, feedId, url, title, bypassCache, roundToken } = job.data
  const ownerDbName = await resolveOwnerDbName(owner)
  const startedAt = new Date()

  // 读该源在这个 owner 库里的保留条数（自适应算出来的，见 services/feed-retention-policy.ts）
  const schedule = await readSchedule(ownerDbName).catch(() => null)
  const entry = schedule?.sources?.[feedId]
  const retentionEntries = normalizeRetention(entry?.retentionEntries)

  try {
    if (bypassCache) await dropFetchCache(url)

    const result = await fetchOwnerFeed({
      owner: { kind: owner.kind, id: owner.id },
      feedId,
      url,
      title,
      paused: entry?.paused === true,
      retentionEntries,
    })

    if (result.skipped) {
      return { owner, feedId, newEntries: 0, trimmed: 0, networkFetch: false, skipped: result.skipped }
    }

    // 记进本轮记账簿（见 ./fetch-round.ts）：只加数字，不写库。令牌对不上（迟到/手动触发的 job）
    // 会被安静丢弃 —— 同步日志是给人看的，不该为记账再引入一次写入失败的可能。
    fetchRounds.note(roundKey(owner.kind, owner.id), roundToken, {
      newEntries: result.newEntries,
      trimmedEntries: result.trimmed,
    })

    // 抓取成功（含"没新内容"）：归零失败计数，记下验证器能力（自适应降频的输入）
    const hasValidators = await detectValidators(url)
    await mergeSourceSchedule(ownerDbName, feedId, {
      lastFetchedAt: startedAt.toISOString(),
      ...(result.newEntries > 0 ? { lastNewEntryAt: startedAt.toISOString() } : {}),
      errorStreak: 0,
      hasValidators,
      retentionEntries,
    })

    if (result.newEntries > 0 || result.trimmed > 0) {
      console.log(
        `[Fetch] ${owner.kind}=${owner.id} 源=${feedId} 新增=${result.newEntries} `
        + `裁剪=${result.trimmed}${result.networkFetch ? "" : "（缓存命中）"}`,
      )
    }

    // Bot 有新产出 → 搬给订阅了这个 Bot 的用户。
    //
    // 为什么放在这里而不是另开队列：用户库与 Bot 库之间没有复制（新模型按 owner 各写各的），
    // 而"订阅了一个 Bot"是用户侧的订阅文档，只能由我们主动送过去。
    // Bot 产出是低频事件（一个 Bot 一天几条），不是 RSS 源那种"几百个源 × 每源几十条"，
    // 所以不会重新长出一个扇出层。
    if (owner.kind === "bot" && result.newEntries > 0) {
      void syncBotEntryToSubscribers(owner.id).catch((err) => {
        console.warn(`[Bot] ${owner.id} 产出同步失败：${(err as Error)?.message ?? err}`)
      })
    }
    return {
      owner,
      feedId,
      newEntries: result.newEntries,
      trimmed: result.trimmed,
      networkFetch: result.networkFetch,
    }
  } catch (err) {
    const previous = entry?.errorStreak ?? 0
    await mergeSourceSchedule(ownerDbName, feedId, {
      // 失败也算"抓过一次"，否则坏源会被同一轮反复重试
      lastFetchedAt: startedAt.toISOString(),
      lastErrorAt: startedAt.toISOString(),
      errorStreak: previous + 1,
    }).catch(() => {})
    // 失败同样记进本轮：同步日志里「失败 N 个源」就是靠这一行
    fetchRounds.note(roundKey(owner.kind, owner.id), roundToken, { failures: 1 })
    throw err
  }
}

/**
 * 该源最近一次响应有没有条件请求验证器（决定自适应降频是否更激进）。
 *
 * 读缓存 meta 而不是再发一次请求：`getFeedContent` 刚刚写过它。
 * 读不到就按"有验证器"处理（保守：不提前降频，宁可多抓几次也别漏内容）。
 */
async function detectValidators(url: string): Promise<boolean> {
  try {
    const { readFetchCacheMeta } = await import("../rss/fetch-cache")
    const meta = await readFetchCacheMeta(url)
    return meta?.hasValidators ?? true
  } catch {
    return true
  }
}

async function dropFetchCache(url: string): Promise<void> {
  const { invalidateFetchCache } = await import("../rss/fetch-cache")
  await invalidateFetchCache(url).catch(() => {})
}

async function resolveOwnerDbName(owner: FetchOwnerJob): Promise<string> {
  return owner.kind === "user"
    ? await ensureTimelineDatabase(owner.id)
    : await ensureBotDatabase(owner.id)
}

/**
 * 入队一次抓取（单 owner 单源）。
 *
 * 已结束的旧 job 必须先删掉，否则 jobId 会被 BullMQ 判定为重复而拒绝新 job
 * —— 这正是 `enqueueFetchJob` 里那段"改地址后点立即抓取没反应"的坑，逻辑一致。
 */
export async function enqueueFetchJobFor(
  queue: Queue,
  data: FetchJobData,
  options: { delay?: number } = {},
): Promise<void> {
  const jobId = fetchJobId(data.owner, data.feedId)
  const existing = await queue.getJob(jobId)
  if (existing) {
    const state = await existing.getState()
    if (state === "active") {
      // 正在跑：BullMQ 不允许删除 active job，尽力把 data 换成最新值
      await existing.updateData(data).catch(() => {})
      return
    }
    await existing.remove()
  }
  await queue.add(`fetch:${jobId}`, data, {
    jobId,
    delay: options.delay ?? 0,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 50 },
  })
}

/**
 * 入队一次抓取（供服务层调用）。
 *
 * 与队列内部的 `enqueueFetchJobFor` 分开，是为了让服务层不必知道队列实例：
 * 它只表达「这个 owner 的这个源该抓了」。
 */
export async function enqueueOwnerFetch(data: FetchJobData): Promise<void> {
  await enqueueFetchJobFor(fetchQueue, data)
}

/**
 * 入队该 owner 全部订阅源的一次抓取（订阅后首抓 / 手动刷新用）。
 *
 * 从库里读订阅文档而不是接收参数：调用方（路由）不该重复实现"哪些订阅要抓"。
 */
export async function enqueueOwnerSubscriptions(owner: FetchOwnerJob, options: { bypassCache?: boolean } = {}): Promise<number> {
  const jobs = await collectOwnerSources(owner)
  let queued = 0
  for (const source of jobs) {
    if (source.paused) continue
    try {
      await enqueueOwnerFetch({
        owner,
        feedId: source.feedId,
        url: source.url,
        title: source.title,
        bypassCache: options.bypassCache,
      })
      queued += 1
    } catch (err) {
      // 单个源入队失败不该拦下其余几百个
      console.warn(`[Fetch] 源 ${source.feedId} 入队失败：${(err as Error)?.message ?? err}`)
    }
  }
  return queued
}

export interface OwnerSource {
  feedId: string
  url: string
  title: string
  /** 用户暂停了这条订阅 */
  paused: boolean
}

/**
 * 收集某 owner 当前要抓的源（用户：库里的订阅文档；Bot：`bot_feeds` 表）。
 *
 * 脏文档（缺 url / feedId 与 url 不匹配 / `kind: 'bot'` 的 Bot 订阅）在这里就被过滤掉并计数，
 * 让调度日志能看见"有多少条订阅是坏的"，而不是静默少抓。
 */
export async function collectOwnerSources(owner: FetchOwnerJob): Promise<OwnerSource[]> {
  if (owner.kind === "bot") {
    const rows = await db.select().from(botFeeds).where(eq(botFeeds.botId, owner.id))
    return rows.map((row) => ({
      feedId: row.feedId,
      url: row.url,
      title: row.title,
      paused: row.paused,
    }))
  }

  const dbName = await ensureTimelineDatabase(owner.id)
  const scope = createCouchDb(dbName)
  const { rows } = await scope.list({
    startkey: "subscription:",
    endkey: "subscription:\uffff",
    include_docs: true,
  })
  const out: OwnerSource[] = []
  for (const row of rows) {
    const parsed = parseSubscription(row.doc as never)
    if (!parsed.ok) {
      // 老数据（重构前写的订阅没有 url）会落到 missing-url；它们没法自动修，
      // 只能由用户重新订阅一次 —— 测试期直接清库重来，不做兼容。
      if (parsed.reason !== "bot-subscription") {
        console.warn(`[Fetch] 跳过脏订阅 ${row.id}：${parsed.reason}`)
      }
      continue
    }
    out.push({ feedId: parsed.feedId, url: parsed.url, title: parsed.title, paused: parsed.paused })
  }
  return out
}

const FETCH_INTERVAL = envInt("FETCH_INTERVAL", 900_000)
/**
 * 自适应抓取间隔（默认开）：内容久未更新的源降低轮询频率（15m→30m→1h→3h→6h），
 * 抓到新条目后立刻回到基础间隔。规则见 workers/fetch-schedule.ts。
 * 设为 0 恢复「每轮把全部源都入队」的旧行为。
 */
const FETCH_ADAPTIVE = process.env.FETCH_ADAPTIVE !== "0"
/** 自适应降频的上限（默认 6 小时） */
const FETCH_MAX_INTERVAL = envInt("FETCH_MAX_INTERVAL", 6 * 60 * 60 * 1000)
/** 无验证器源提前一档降频（默认开；`FETCH_NO_VALIDATOR_SLOWDOWN=0` 关闭，见 fetch-schedule.ts） */
const FETCH_NO_VALIDATOR_SLOWDOWN = process.env.FETCH_NO_VALIDATOR_SLOWDOWN !== "0"
/** 调度错峰窗口：基础间隔的 10%（默认 90s），把同一 tick 到期的几百个源摊开入队 */
const FETCH_JITTER_SPAN_MS = Math.max(0, Math.floor(FETCH_INTERVAL * 0.1))
export const fetchScheduleOptions: FetchScheduleOptions = {
  baseIntervalMs: FETCH_INTERVAL,
  maxIntervalMs: FETCH_MAX_INTERVAL,
  enabled: FETCH_ADAPTIVE,
  slowNonValidator: FETCH_NO_VALIDATOR_SLOWDOWN,
}

/**
 * 调度一轮：枚举所有用户的库 + 所有 Bot，按各自的 `_local/schedule` 判断哪些源到期。
 *
 * 这一轮的成本 = 每个 owner 2 个 CouchDB 请求（订阅区间查询 + `_local/schedule`）。
 * 相比旧实现的一条 `SELECT * FROM feeds WHERE status='active'` 是变贵了，
 * 但它换来的是**没有订阅关系的投影表**（那张表必须从客户端可写文档同步、会漂移）。
 *
 * 每一轮都顺手把**上一轮**的记账结算成一条同步日志（见 ./fetch-round.ts）：
 * 调度时只能定下「订阅多少源 / 到期多少源」，新增与失败要等 job 跑完才知道，
 * 所以流水总是晚一个 tick 出现 —— 它记的是「上一轮抓取干了什么」，不是「这一轮正在干什么」。
 * 心跳同样在结算时更新，「正在跑」这件事由本轮的 job 自己体现（列表顶部有同步指示器）。
 */
export async function scheduleOwnerFetches(): Promise<void> {
  const targets = await collectScheduleTargets()
  const now = Date.now()
  let dueTotal = 0
  let sourceTotal = 0

  for (const target of targets) {
    // 先结算上一轮，再判休眠：休眠用户的未结算轮次也不能永远挂在记账簿里。
    // 记账只针对用户 —— 流水表按 userId 归属，Bot 没有对应的用户行（Bot 抓取失败只进服务端日志）。
    const bookKey = target.owner.kind === "user" ? roundKey("user", target.owner.id) : null
    const settled = bookKey ? fetchRounds.settle(bookKey, now) : null
    if (settled) {
      void recordFetchRound({ userId: target.owner.id, round: settled.round, ms: settled.ms })
    }

    if (target.paused) continue

    const sources = await collectOwnerSources(target.owner).catch((err) => {
      console.warn(`[Fetch] 读取 ${target.owner.kind}=${target.owner.id} 的订阅失败：${(err as Error)?.message ?? err}`)
      return [] as OwnerSource[]
    })
    sourceTotal += sources.length
    if (sources.length === 0) continue

    const schedule = await readSchedule(target.dbName).catch(() => null)
    const due = sources.filter((source) => {
      if (source.paused) return false
      const entry = schedule?.sources?.[source.feedId]
      return isFeedDue({
        lastFetchedAt: entry?.lastFetchedAt ? new Date(entry.lastFetchedAt) : null,
        lastNewEntryAt: entry?.lastNewEntryAt ? new Date(entry.lastNewEntryAt) : null,
        createdAt: null,
        errorMessage: entry?.errorStreak && entry.errorStreak > 0 ? "error" : null,
        errorStreak: entry?.errorStreak ?? 0,
        hasFetchValidators: entry?.hasValidators ?? null,
      }, fetchScheduleOptions, now)
    })

    // 到期为 0 也要开一轮：空转本身是答案（「跑过但没有要抓的」≠「没跑」）。
    // 少记一条由 recordFetchRound 的合并窗口负责，调度这边不省。
    const roundToken = bookKey
      ? fetchRounds.begin(bookKey, { sources: sources.length, due: due.length, now })
      : undefined
    if (due.length === 0) continue
    dueTotal += due.length

    for (const source of due) {
      await enqueueFetchJobFor(fetchQueue, {
        owner: target.owner,
        feedId: source.feedId,
        url: source.url,
        title: source.title,
        // 令牌只为结算服务：手动触发的 job 不带它，于是不会混进定时轮次的账
        ...(roundToken ? { roundToken } : {}),
      }, {
        // 错峰：一个 tick 内到期的几百个源不必同一秒开跑（延迟按 jobId 确定性哈希）
        delay: feedJitterMs(fetchJobId(target.owner, source.feedId), FETCH_JITTER_SPAN_MS),
      })
    }
  }

  // 每 15 分钟一行，方便在日志里对照「本轮为什么少了这么多源」
  console.log(`[Fetch] 调度: ${dueTotal}/${sourceTotal} 个源到期（${targets.length} 个 owner）`)
}

// 测试进程里也不挂调度定时器：`vitest --watch` 一挂几小时的话，它会按 FETCH_INTERVAL
// 往真实队列里灌任务。调度里的任何一步（PG/Redis/CouchDB）失败都不该把进程带走。
const fetchInterval = isTestProcess ? null : setInterval(() => {
  scheduleOwnerFetches().catch((err) => {
    console.error("[Fetch] 调度失败（下一轮继续）:", err instanceof Error ? err.message : err)
  })
}, FETCH_INTERVAL)

export async function shutdownFetchWorker(): Promise<void> {
  if (fetchInterval) clearInterval(fetchInterval)
  // 测试进程里 worker 为 null（见 isTestProcess 注释）
  await worker?.close()
  await fetchQueue.close()
}

/**
 * 把某个 Bot 的最新产出同步给它所有的用户订阅者。
 *
 * 枚举订阅者要扫所有用户库（没有订阅关系的投影表 —— 取舍见 ARCHITECTURE.md），
 * 所以只在**这个 Bot 真的有新产出**时才跑（调用点已判 `newEntries > 0`）。
 */
async function syncBotEntryToSubscribers(botId: string): Promise<void> {
  const users = await db.select({ id: user.id, dbName: user.timelineDbName }).from(user)
  const subscribers = await listBotSubscribers(botId, users)
  if (subscribers.length === 0) return
  for (const userId of subscribers) {
    const result = await syncBotEntriesToUser(botId, userId)
    if (result.copied > 0) {
      console.log(`[Bot] ${botId} 产出同步给 user=${userId}：${result.copied} 条`)
    }
  }
}

/** 解析并规范化一条订阅文档（导出给路由/工具复用） */
export { parseSubscription, deriveFeedId }
