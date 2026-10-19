import { storage as defaultStorage, type Storage, type StorageObjectInfo } from "../storage"
import { IMAGE_CACHE_PREFIX } from "./cache"
import { envInt } from "../env"

/**
 * 图片缓存清理（GC）。
 *
 * 缓存对象是抓取去重用的中间产物，没有引用计数：条目被保留策略裁掉之后，
 * 它对应的缓存对象仍然留在 Storage 里。所以只能按「时间」清理 —— 保留 N 天
 * （默认 30，`IMAGE_CACHE_TTL_DAYS`）足够覆盖「同一张模板图在连续几篇文章里重复出现」
 * 的窗口，再老的几乎不会再被引用；删掉最多是下次遇到同 URL 时重下一遍，不丢数据。
 *
 * 顺手删除 `.json` 对象：那是旧的 sidecar 元数据（尺寸 / blurhash / 来源），
 * 现在命中路径改为从 AVIF 本体现算，这些对象已经没有任何读者。
 *
 * 扫描是**流式**的（`Storage.listBatches` 按批 yield），不把整个前缀 list 进内存：
 * 对象数随流量线性增长（实测 11 天 8.9 万个 / 2.1GB，约 8 千个/天；30 天 TTL 稳态约 26 万个），
 * 一次性 list 等于把单轮 GC 的峰值内存绑在缓存总量上（实测约 240B/对象，百万级 ≈ 240MB）。
 * 按批扫、边扫边删，峰值内存只与批大小有关，跟缓存有多大无关。
 *
 * 单轮删除有上限（默认 20000）：首次上线要清掉历史 sidecar 时，避免在启动阶段
 * 一口气发几万个 DELETE 把对象存储打满；没删完的下一轮继续。
 */

/** 默认保留天数（<=0 关闭清理） */
const DEFAULT_TTL_DAYS = 30
/** 每日跑一次 */
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单轮最多删除的对象数（避免首次清理的请求尖峰） */
const DEFAULT_MAX_DELETES = 20_000
/** 每批扫描的对象数（S3 单页上限 1000；本地后端按目录顺序攒批） */
const DEFAULT_BATCH_SIZE = 1000
/** 删除并发 */
const DELETE_CONCURRENCY = 16
const DAY_MS = 24 * 60 * 60 * 1000

/** 读保留天数：空串/非法值回退默认；0/负数表示关闭清理（由调用方判断） */
function ttlDaysFromEnv(): number {
  return envInt("IMAGE_CACHE_TTL_DAYS", DEFAULT_TTL_DAYS, { min: -1 })
}

/** 字节 → 日志用的 MB 文本 */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export interface ImageCacheGcOptions {
  storage?: Storage
  /** 保留天数；<=0 表示关闭清理（不删任何东西） */
  ttlDays?: number
  /** 当前时间（测试注入） */
  now?: number
  /** 单轮删除上限 */
  maxDeletes?: number
  /** 每批扫描的对象数 */
  batchSize?: number
}

export interface ImageCacheGcResult {
  /** 扫描到的缓存对象总数 */
  scanned: number
  /** 扫描到的对象总体积 */
  scannedBytes: number
  /** 最老对象的年龄（天）；缓存为空时为 0 */
  oldestAgeDays: number
  /** 本轮实际删除数 */
  deleted: number
  /** 删除对象的总体积 */
  deletedBytes: number
  /** 其中历史 sidecar（.json）的数量 */
  deletedLegacyMeta: number
  /** 其中超过 TTL 的 AVIF 数量 */
  deletedExpired: number
  /** 删除失败的数量 */
  failed: number
  /** 本轮结束后仍保留的对象数（含失败未删的） */
  kept: number
  /** 达到单轮删除上限、还有对象留待下一轮 */
  capped: boolean
}

/** 执行一轮清理（流式扫描 + 批量删除，失败只计数不抛错） */
export async function gcImageCache(options: ImageCacheGcOptions = {}): Promise<ImageCacheGcResult> {
  const ttlDays = options.ttlDays ?? ttlDaysFromEnv()
  const empty: ImageCacheGcResult = {
    scanned: 0, scannedBytes: 0, oldestAgeDays: 0,
    deleted: 0, deletedBytes: 0, deletedLegacyMeta: 0, deletedExpired: 0,
    failed: 0, kept: 0, capped: false,
  }
  if (ttlDays <= 0) return empty

  const store = options.storage ?? defaultStorage
  const now = options.now ?? Date.now()
  const maxAgeMs = ttlDays * DAY_MS
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE

  const prefix = `${IMAGE_CACHE_PREFIX}/`
  let scanned = 0
  let scannedBytes = 0
  let oldestModified = Number.POSITIVE_INFINITY
  let deleted = 0
  let deletedBytes = 0
  let deletedLegacyMeta = 0
  let deletedExpired = 0
  let failed = 0
  /** 已纳入本轮删除计划的对象数（受单轮上限约束） */
  let planned = 0
  let capped = false

  /** 删一批目标（并发受 DELETE_CONCURRENCY 限制；失败只计数不抛错） */
  const deleteBatch = async (targets: StorageObjectInfo[]): Promise<void> => {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const object = targets[cursor++]!
        try {
          await store.delete(object.key)
          deleted++
          deletedBytes += object.size
          if (object.key.endsWith(".json")) deletedLegacyMeta++
          else deletedExpired++
        } catch {
          failed++
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, targets.length) }, worker),
    )
  }

  for await (const batch of store.listBatches(prefix, batchSize)) {
    const targets: StorageObjectInfo[] = []
    for (const object of batch) {
      // 前缀由调用方固定传入；再过滤一次是为了防御自定义 Storage 实现返回多余 key
      if (!object.key.startsWith(prefix)) continue
      scanned++
      scannedBytes += object.size
      const modified = object.lastModified.getTime()
      if (modified < oldestModified) oldestModified = modified

      // 旧 sidecar 优先删（已无读者），再删过期 AVIF；两者共享单轮上限
      const isLegacyMeta = object.key.endsWith(".json")
      const isExpired = !isLegacyMeta && now - modified > maxAgeMs
      if (!isLegacyMeta && !isExpired) continue
      if (planned >= maxDeletes) {
        // 达单轮上限：本轮不再删，但继续扫完，好让日志里的剩余量是准确的
        capped = true
        continue
      }
      planned++
      targets.push(object)
    }
    await deleteBatch(targets)
  }

  const hasObjects = scanned > 0 && Number.isFinite(oldestModified)
  return {
    scanned,
    scannedBytes,
    oldestAgeDays: hasObjects ? (now - oldestModified) / DAY_MS : 0,
    deleted,
    deletedBytes,
    deletedLegacyMeta,
    deletedExpired,
    failed,
    kept: scanned - deleted,
    capped,
  }
}

/**
 * 启动内建清理任务：启动后立即跑一次（异步、不阻塞启动），之后每 24h 一次。
 * 定时器 unref，不阻止进程退出；清理失败只打日志，不影响抓取与 API。
 */
export function startImageCacheGc(intervalMs = GC_INTERVAL_MS): NodeJS.Timeout {
  const run = (): void => {
    gcImageCache()
      .then((r) => {
        if (r.scanned === 0) {
          console.log("[ImageCacheGC] 缓存为空，跳过")
          return
        }
        const tail = r.capped ? "（达单轮上限，下一轮继续）" : ""
        console.log(
          `[ImageCacheGC] 扫描 ${r.scanned} 个（${formatMb(r.scannedBytes)}，最老 ${r.oldestAgeDays.toFixed(1)} 天），` +
          `删除 ${r.deleted}（sidecar ${r.deletedLegacyMeta} / 过期 ${r.deletedExpired}），失败 ${r.failed}，` +
          `剩余 ${r.kept} 个（${formatMb(r.scannedBytes - r.deletedBytes)}）${tail}`,
        )
      })
      .catch((err) => {
        console.warn("[ImageCacheGC] 清理失败:", err instanceof Error ? err.message : err)
      })
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return timer
}
