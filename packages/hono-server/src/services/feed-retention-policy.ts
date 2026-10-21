/**
 * 自适应保留条数的**纯策略**：活动度 → 目标 N，含分档与滞回。
 *
 * 这里不碰数据库/CouchDB，边界由 `__tests__/feed-retention.test.ts` 钉住；
 * I/O 与定时任务在 `services/feed-retention.ts`。
 */
import { DEFAULT_SOURCE_RETENTION_ENTRIES } from "../couchdb/retention"


/** 活跃度统计窗口（天）：只看最近两周，避免用半年前的活跃度决定今天的保留策略 */
export const RETENTION_ACTIVITY_WINDOW_DAYS = 14
/** 档位边界相对阈值的滞回比例（20%） */
export const RETENTION_HYSTERESIS = 0.2
/** 样本不足（条目太少）时不算活动度：没有足够的历史分布，保持原 N */
export const RETENTION_MIN_SAMPLE_ENTRIES = 3
/** 时间跨度下限（天）：几条同一时刻写入的条目不能推出"日均千万字节" */
const RETENTION_MIN_SPAN_DAYS = 1 / 24

export interface RetentionTier {
  /** 进入该档所需的最小日均新增字节（最后一档为 0） */
  minBytesPerDay: number
  /** 该档保留的条数 */
  entries: number
}

/**
 * 由「活跃」到「不活跃」排列的档位。最后一档用全局上限，改 `SOURCE_RETENTION_ENTRIES` 时
 * 自动跟随（但不会超过它）。
 */
export const RETENTION_TIERS: readonly RetentionTier[] = [
  { minBytesPerDay: 2 * 1024 * 1024, entries: 10 },
  { minBytesPerDay: 512 * 1024, entries: 20 },
  { minBytesPerDay: 128 * 1024, entries: 30 },
  { minBytesPerDay: 0, entries: DEFAULT_SOURCE_RETENTION_ENTRIES },
]

/** 源库活动度快照（只含推导 N 需要的字段） */
export interface FeedActivitySnapshot {
  /** 活文档的未压缩字节（CouchDB `sizes.external`，含附件） */
  externalBytes: number
  /** 活文档数（含 FeedDoc / 设计文档） */
  docCount: number
  /** 最新条目的 publishedAt（视图首行 key） */
  newestPublishedAt?: string
  /** 最旧条目的 publishedAt（视图末行 key） */
  oldestPublishedAt?: string
}

/**
 * 近 14 天折算的日均新增字节。
 *
 * - 条目太少 / 时间无效 → `null`（样本不足，不要拿噪声改 N）
 * - 跨度超过 14 天 → 分母按 14 天算（近似：外部字节里混有更老的条目，会把活跃度高估一点，
 *   但对低频源本来就落在最大档，不影响结果）
 * - 跨度很短（同一批写入）→ 分母下限 1 小时，避免除以接近 0 的数
 */
export function computeActivityBytesPerDay(snapshot: FeedActivitySnapshot): number | null {
  const { externalBytes, docCount, newestPublishedAt, oldestPublishedAt } = snapshot
  if (!Number.isFinite(externalBytes) || externalBytes < 0) return null
  if (!Number.isFinite(docCount) || docCount < RETENTION_MIN_SAMPLE_ENTRIES) return null
  const newest = Date.parse(newestPublishedAt ?? "")
  const oldest = Date.parse(oldestPublishedAt ?? "")
  if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return null
  const spanDays = (newest - oldest) / 86_400_000
  if (!Number.isFinite(spanDays) || spanDays < 0) return null
  const windowDays = Math.min(
    RETENTION_ACTIVITY_WINDOW_DAYS,
    Math.max(spanDays, RETENTION_MIN_SPAN_DAYS),
  )
  return externalBytes / windowDays
}

/** 档位里离 `entries` 最近的索引（current 只可能是我们自己写过的档位值） */
function levelIndexForEntries(entries: number): number {
  let best = 0
  for (let i = 0; i < RETENTION_TIERS.length; i++) {
    if (RETENTION_TIERS[i]!.entries <= entries) best = i
  }
  return best
}

/**
 * 算出下一次要用的 N（纯函数，边界由单测钉住）。
 *
 * 规则见文件头：首次直接落档；之后一次最多变一档，且要明确越过 20% 滞回带。
 */
export function nextRetentionEntries(current: number | null, bytesPerDay: number | null): number {
  const tiers = RETENTION_TIERS
  const currentN = current ?? DEFAULT_SOURCE_RETENTION_ENTRIES
  const currentIndex = levelIndexForEntries(currentN)
  // 还没算过：直接落到目标档（不再逐档过渡）
  const isFirstComputation = current === null
  if (bytesPerDay === null || !Number.isFinite(bytesPerDay) || bytesPerDay < 0) {
    return tiers[currentIndex]!.entries
  }

  let desiredIndex = tiers.length - 1
  for (let i = 0; i < tiers.length; i++) {
    if (bytesPerDay >= tiers[i]!.minBytesPerDay) {
      desiredIndex = i
      break
    }
  }
  if (isFirstComputation || desiredIndex === currentIndex) {
    return tiers[desiredIndex]!.entries
  }

  if (desiredIndex < currentIndex) {
    // 想收得更紧：必须明确高于目标档的门槛（带滞回），否则贴着边界时不动
    const threshold = tiers[desiredIndex]!.minBytesPerDay * (1 + RETENTION_HYSTERESIS)
    if (bytesPerDay < threshold) return tiers[currentIndex]!.entries
  } else {
    // 想放宽：必须明确低于当前档的门槛（带滞回）
    const threshold = tiers[currentIndex]!.minBytesPerDay * (1 - RETENTION_HYSTERESIS)
    if (bytesPerDay > threshold) return tiers[currentIndex]!.entries
  }

  // 一次只挪一档：单日尖峰不能把历史一次删光
  const step = Math.sign(desiredIndex - currentIndex)
  return tiers[currentIndex + step]!.entries
}

