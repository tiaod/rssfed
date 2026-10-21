/**
 * 源库**自适应保留条数**的 I/O 与编排（策略/分档在 `feed-retention-policy.ts`）。
 *
 * 为什么只动源库、不动用户库：保留策略的唯一权威是源库裁剪，删除随复制传播，用户库因此
 * 是精确镜像；CouchDB 复制过滤器表达不了「最新 N 条」，每用户 N 只能退化成目标端再删，
 * 破坏镜像且要重新引入每用户扫描，不做。
 *
 * 活动度只读源库自身（`GET /{db}` 的 sizes + `entries-by-date` 视图首尾行），不读正文；
 * 每天全量跑 700 多个库只是几千个小请求。
 */
import { eq, sql } from "drizzle-orm"
import { db, feeds } from "../db"
import { envInt } from "../env"
import { nanoServer } from "../couchdb/client"
import {
  createTrimDb,
  DEFAULT_SOURCE_RETENTION_ENTRIES,
  trimSourceToLatestN,
} from "../couchdb/retention"
import {
  computeActivityBytesPerDay,
  nextRetentionEntries,
  RETENTION_MIN_SAMPLE_ENTRIES,
  type FeedActivitySnapshot,
} from "./feed-retention-policy"

export * from "./feed-retention-policy"

export interface AdaptiveRetentionConfig {
  dryRun: boolean
  concurrency: number
  /** 只处理前 N 个源（脚本/灰度用） */
  maxFeeds?: number
  now: Date
}

export function readAdaptiveRetentionConfig(
  overrides: Partial<AdaptiveRetentionConfig> = {},
): AdaptiveRetentionConfig {
  return {
    dryRun: false,
    concurrency: envInt("FEED_RETENTION_CONCURRENCY", 4, { min: 1, max: 8 }),
    maxFeeds: undefined,
    now: new Date(),
    ...overrides,
  }
}

export interface AdaptiveRetentionStats {
  dryRun: boolean
  /** 处理过的源数 */
  feeds: number
  /** N 发生变化的源数 */
  changed: number
  /** 其中收紧了 N（会触发裁剪 + 镜像删除）的源数 */
  shrunk: number
  /** 真正删掉的条目数 */
  trimmed: number
  /** 样本不足 / 视图缺失而跳过的源数 */
  skipped: number
  errors: Array<{ feedId: string, error: string }>
  elapsedMs: number
}

/** 从源库读活动度快照：库信息（sizes.external / doc_count）+ 视图首尾行（不读正文） */
export async function readFeedActivity(dbName: string): Promise<FeedActivitySnapshot | null> {
  const db = nanoServer.use(dbName)
  let info: { doc_count?: number, sizes?: { external?: number } }
  try {
    info = await db.info() as typeof info
  } catch {
    // 库打不开（被删/权限）→ 这轮跳过，下一轮再看
    return null
  }
  const docCount = typeof info?.doc_count === "number" ? info.doc_count : 0
  if (docCount < RETENTION_MIN_SAMPLE_ENTRIES) return null
  const externalBytes = typeof info?.sizes?.external === "number" ? info.sizes.external : 0

  try {
    const [newest, oldest] = await Promise.all([
      db.view("main", "entries-by-date", { limit: 1, descending: true, include_docs: false }),
      db.view("main", "entries-by-date", { limit: 1, include_docs: false }),
    ])
    const newestKey = (newest?.rows?.[0] as { key?: unknown } | undefined)?.key
    const oldestKey = (oldest?.rows?.[0] as { key?: unknown } | undefined)?.key
    return {
      externalBytes,
      docCount,
      newestPublishedAt: typeof newestKey === "string" ? newestKey : undefined,
      oldestPublishedAt: typeof oldestKey === "string" ? oldestKey : undefined,
    }
  } catch {
    // 新库还没装设计文档 / 视图查询失败：这轮不判断
    return null
  }
}

export interface AdaptiveRetentionFeed {
  id: string
  couchDbName: string
  retentionEntries: number | null
}

/** 要参与自适应保留的源（有 feed 库的都算；bot 库不裁剪） */
export async function listAdaptiveRetentionFeeds(): Promise<AdaptiveRetentionFeed[]> {
  const rows = await db.select({
    id: feeds.id,
    couchDbName: feeds.couchDbName,
    retentionEntries: feeds.retentionEntries,
  })
    .from(feeds)
    .where(sql`${feeds.couchDbName} is not null and ${feeds.couchDbName} like ${"feed_%"}`)
  return rows.flatMap((row) => (row.couchDbName
    ? [{ id: row.id, couchDbName: row.couchDbName, retentionEntries: row.retentionEntries }]
    : []))
}

export interface FeedRetentionInspection {
  feedId: string
  couchDbName: string
  docCount: number
  externalBytes: number
  bytesPerDay: number | null
  currentN: number | null
  nextN: number
  changed: boolean
  shrunk: boolean
}

/**
 * 只读地算一遍该源这次会落到的 N（脚本 / dry-run / 排障用，不写库不裁剪）。
 * 源库读不到或视图缺失时返回 null（下一轮再看）。
 */
export async function inspectAdaptiveRetentionFeed(
  feed: AdaptiveRetentionFeed,
): Promise<FeedRetentionInspection | null> {
  const snapshot = await readFeedActivity(feed.couchDbName)
  if (!snapshot) return null
  const bytesPerDay = computeActivityBytesPerDay(snapshot)
  const nextN = nextRetentionEntries(feed.retentionEntries, bytesPerDay)
  return {
    feedId: feed.id,
    couchDbName: feed.couchDbName,
    docCount: snapshot.docCount,
    externalBytes: snapshot.externalBytes,
    bytesPerDay,
    currentN: feed.retentionEntries,
    nextN,
    changed: nextN !== feed.retentionEntries,
    shrunk: nextN < (feed.retentionEntries ?? DEFAULT_SOURCE_RETENTION_ENTRIES),
  }
}

/**
 * 处理单个源：算活动度 → 定 N → 写回 PG → 把源库裁到 N。
 *
 * 裁剪总是执行（不只是 N 变小时）：这一遍同时充当"上次没裁完"的自愈，成本只是一次视图计数。
 */
export async function runAdaptiveRetentionForFeed(
  feed: AdaptiveRetentionFeed,
  config: AdaptiveRetentionConfig,
): Promise<{ changed: boolean, shrunk: boolean, trimmed: number, skipped: boolean }> {
  const inspection = await inspectAdaptiveRetentionFeed(feed)
  if (!inspection) return { changed: false, shrunk: false, trimmed: 0, skipped: true }

  const { changed, shrunk, nextN, bytesPerDay } = inspection
  if (config.dryRun) return { changed, shrunk, trimmed: 0, skipped: false }

  const trim = await trimSourceToLatestN(createTrimDb(feed.couchDbName), {
    n: nextN,
    compact: false,
  })
  const now = config.now
  await db.update(feeds).set({
    retentionEntries: nextN,
    activityBytesPerDay: bytesPerDay === null ? null : Math.round(bytesPerDay),
    activityComputedAt: now,
    // 裁掉了条目 = 源内容变了：bump lastChangedAt，下一轮聚合把删除同步到用户库/浏览器
    ...(trim.deleted > 0 ? { lastChangedAt: now } : {}),
  }).where(eq(feeds.id, feed.id))
  return { changed, shrunk, trimmed: trim.deleted, skipped: false }
}

/**
 * 跑一轮自适应保留。默认处理全部 feed 源；`maxFeeds` 用于脚本/灰度。
 *
 * 不吞异常：单个源失败只记录并继续（一个坏库不能让整轮停摆）。
 */
export async function runAdaptiveRetention(
  config: AdaptiveRetentionConfig = readAdaptiveRetentionConfig(),
): Promise<AdaptiveRetentionStats> {
  const startedAt = Date.now()
  const stats: AdaptiveRetentionStats = {
    dryRun: config.dryRun,
    feeds: 0,
    changed: 0,
    shrunk: 0,
    trimmed: 0,
    skipped: 0,
    errors: [],
    elapsedMs: 0,
  }

  const allFeeds = await listAdaptiveRetentionFeeds()
  const targets = config.maxFeeds && config.maxFeeds > 0
    ? allFeeds.slice(0, config.maxFeeds)
    : allFeeds
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, config.concurrency) }, async () => {
    while (cursor < targets.length) {
      const feed = targets[cursor++]!
      try {
        const result = await runAdaptiveRetentionForFeed(feed, config)
        stats.feeds += 1
        if (result.skipped) stats.skipped += 1
        if (result.changed) stats.changed += 1
        if (result.shrunk) stats.shrunk += 1
        stats.trimmed += result.trimmed
      } catch (err) {
        stats.errors.push({
          feedId: feed.id,
          error: ((err as Error)?.message ?? String(err)).slice(0, 300),
        })
      }
    }
  })
  await Promise.all(workers)
  stats.elapsedMs = Date.now() - startedAt
  return stats
}
