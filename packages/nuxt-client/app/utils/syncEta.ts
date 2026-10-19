/**
 * 复制剩余时间（ETA）估算。
 *
 * 为什么不按「云端体积 ÷ 带宽」估：
 *   1. 只有首次全量同步才要过几百 MB，日常增量只拉 `_changes` 之后的新文档，体积与耗时无关；
 *   2. 实际耗时的大头常在浏览器侧 —— 附件要逐个取回、再作为 Blob 写进 IndexedDB，
 *      客户端写入速度与网络速度没有固定关系（见 usePouchDb 的 REPLICATE_BATCH_SIZE 注释）；
 *   3. 单篇文档体积差异极大（带图条目几百 KB、状态文档几十字节），按字节均摊也不比按条数准。
 *
 * 所以这里只用复制事件自带的两个数：`pending`（服务端剩余变更数）与 `docs_written`
 * （本次复制累计写入数）。用一段时间内的写入速率乘剩余条数得到 ETA，
 * 速率随实际吞吐自动变化，不需要预先知道库有多大。
 *
 * 样本门槛（ETA_MIN_*）：首批可能全是小体积的状态文档、也可能恰好是一批大图条目，
 * 速率会明显偏离真实值。等积累到一定时长与条数再报，宁可先显示「正在拉取」。
 */

/** 至少积累这么久才给 ETA（毫秒）：太短的窗口里，一批文档的体积就能把速率带偏 */
export const ETA_MIN_WINDOW_MS = 3000

/** 至少写入这么多文档才给 ETA（不足时多半是小批状态文档，速率不具代表性） */
export const ETA_MIN_DOCS = 3

/** 速率基准：本轮第一次写入时的累计写入数与时间 */
export interface EtaBase {
  /** 累计写入数（PouchDB 的 docs_written，同一复制实例内单调递增） */
  written: number
  /** 记录上述累计值的时间（毫秒时间戳） */
  at: number
}

export interface EtaInput {
  /** 服务端剩余变更数（PouchDB change 事件的 pending；0 = 已经拉完） */
  pending?: number
  /** 本次复制累计写入数（PouchDB change 事件的 docs_written） */
  written?: number
  /** 本轮速率基准 */
  base: EtaBase
  /** 当前时间，可注入便于单测 */
  now?: number
}

/**
 * 估算本轮复制还要多久（毫秒）。
 *
 * 返回 null 表示「算不出来，别显示」：服务端没给 pending、`pending` 已经是 0（拉完了）、
 * 或样本还太少。调用方绝不能把 null 当 0 —— 那会显示「马上完成」并一直停在那儿。
 */
export function computeRemainingMs(input: EtaInput): number | null {
  const { pending, written, base } = input
  if (typeof pending !== 'number' || !Number.isFinite(pending) || pending <= 0) return null
  if (typeof written !== 'number' || !Number.isFinite(written)) return null

  const now = input.now ?? Date.now()
  const elapsed = now - base.at
  if (elapsed < ETA_MIN_WINDOW_MS) return null

  const writtenSinceBase = written - base.written
  // 负数说明基准来自上一轮复制（累计值被重置过），这一轮的数据不可比
  if (writtenSinceBase < ETA_MIN_DOCS) return null

  // 剩余条数 ÷ 当前速率（条/毫秒）
  const remaining = pending / (writtenSinceBase / elapsed)
  if (!Number.isFinite(remaining) || remaining <= 0) return null
  return Math.ceil(remaining)
}

/**
 * ETA 文案（不含「预计还需」这类前缀，调用方按语境拼）。
 *
 * 刻意分档、档内粗粒度取整：速率本身是瞬时值，报「1 分 47 秒」是假精度，
 * 还会让人盯着一个反复跳动的数字。
 */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 10) return '不到 10 秒'
  if (seconds < 60) {
    const rounded = Math.ceil(seconds / 10) * 10
    return rounded < 60 ? `${rounded} 秒` : '1 分钟'
  }
  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}
