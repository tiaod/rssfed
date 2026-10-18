import { storage as defaultStorage, type Storage } from "../storage"
import { IMAGE_CACHE_PREFIX } from "./cache"

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
 * 单轮删除有上限（默认 20000）：首次上线要清掉历史 sidecar 时，避免在启动阶段
 * 一口气发几万个 DELETE 把对象存储打满；没删完的下一轮继续。
 */

/** 默认保留天数（<=0 关闭清理） */
const DEFAULT_TTL_DAYS = 30
/** 每日跑一次 */
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单轮最多删除的对象数（避免首次清理的请求尖峰） */
const DEFAULT_MAX_DELETES = 20_000
/** 删除并发 */
const DELETE_CONCURRENCY = 16

/** 读保留天数：非法/空值回退默认，避免 parseInt("") = NaN 让清理静默失效 */
function ttlDaysFromEnv(): number {
  const parsed = Number.parseInt(process.env.IMAGE_CACHE_TTL_DAYS ?? "", 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_TTL_DAYS
}

export interface ImageCacheGcOptions {
  storage?: Storage
  /** 保留天数；<=0 表示关闭清理（不删任何东西） */
  ttlDays?: number
  /** 当前时间（测试注入） */
  now?: number
  /** 单轮删除上限 */
  maxDeletes?: number
}

export interface ImageCacheGcResult {
  /** 扫描到的缓存对象总数 */
  scanned: number
  /** 本轮实际删除数 */
  deleted: number
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

/** 执行一轮清理（只读列表 + 批量删除，失败只计数不抛错） */
export async function gcImageCache(options: ImageCacheGcOptions = {}): Promise<ImageCacheGcResult> {
  const ttlDays = options.ttlDays ?? ttlDaysFromEnv()
  const empty: ImageCacheGcResult = {
    scanned: 0, deleted: 0, deletedLegacyMeta: 0, deletedExpired: 0, failed: 0, kept: 0, capped: false,
  }
  if (ttlDays <= 0) return empty

  const store = options.storage ?? defaultStorage
  const now = options.now ?? Date.now()
  const maxAgeMs = ttlDays * 24 * 60 * 60 * 1000
  const maxDeletes = options.maxDeletes ?? DEFAULT_MAX_DELETES

  const prefix = `${IMAGE_CACHE_PREFIX}/`
  // 前缀由调用方固定传入；再过滤一次是为了防御自定义 Storage 实现返回多余 key
  const objects = (await store.list(prefix)).filter(o => o.key.startsWith(prefix))

  // 旧 sidecar 优先删（已无读者），再删过期 AVIF；两者共享单轮上限
  const legacyMeta = objects.filter(o => o.key.endsWith(".json"))
  const expired = objects.filter(o => !o.key.endsWith(".json") && now - o.lastModified.getTime() > maxAgeMs)
  const targets = [...legacyMeta, ...expired].slice(0, Math.max(0, maxDeletes))

  let deleted = 0
  let deletedLegacyMeta = 0
  let deletedExpired = 0
  let failed = 0
  let cursor = 0
  const deleteLoop = async (): Promise<void> => {
    while (cursor < targets.length) {
      const object = targets[cursor++]!
      try {
        await store.delete(object.key)
        deleted++
        if (object.key.endsWith(".json")) deletedLegacyMeta++
        else deletedExpired++
      } catch {
        failed++
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, Math.max(1, targets.length)) }, deleteLoop),
  )

  return {
    scanned: objects.length,
    deleted,
    deletedLegacyMeta,
    deletedExpired,
    failed,
    kept: objects.length - deleted,
    capped: targets.length < legacyMeta.length + expired.length,
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
          `[ImageCacheGC] 扫描 ${r.scanned}，删除 ${r.deleted}（sidecar ${r.deletedLegacyMeta} / 过期 ${r.deletedExpired}），失败 ${r.failed}，剩余 ${r.kept}${tail}`,
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
