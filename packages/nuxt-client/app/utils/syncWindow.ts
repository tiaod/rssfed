/**
 * 同步窗口：每个订阅源**首次**同步时只拉取最近 N 天的条目（默认 3 天）。
 *
 * 为什么需要「锚点」（anchor）而不是每次现算 now - N 天：
 * PouchDB 的复制 id 由「源库 id + 目标库 id + filter/selector」算出（pouchdb 的
 * generateReplicationId）。selector 里带一个跟着时钟走的时间戳，复制 id 就每天变一次，
 * 等于**每天把所有订阅源的 _changes 从头扫一遍**（实测 642 个源 ≈ 23MB 元数据流量）。
 * 所以窗口下界一旦确定就固定下来，按「订阅源 + 天数」记在 localStorage。
 *
 * 锚点陈旧是安全的：过滤只作用于「从 0 开始的首轮扫描」；之后的复制从 checkpoint 续跑，
 * 遇到的变更都是发布时间晚于锚点的新条目，过滤结果与不过滤完全一致。
 * 也就是说窗口只决定「本地要补多长的历史」，不会漏掉任何新内容。
 *
 * 窗口变小时不删除本地已有条目（离线优先：已经能离线读的内容不该因为改设置就消失），
 * 只是不再往回补更早的历史。
 */

/** 一天的毫秒数 */
export const DAY_MS = 86_400_000

/** 默认同步窗口：最近 3 天 */
export const DEFAULT_SYNC_WINDOW_DAYS = 3

/**
 * 同步窗口可选值（0 = 不限时间，即改动前的全量行为）。
 *
 * 用固定档位而不是任意数字：每一档对应一条独立的复制 checkpoint（见文件头注释），
 * 档位有限才能保证「改设置 → 重新按新窗口拉一次」的成本可预期。
 *
 * 类型是可变的 `{ label, value }[]`（与 LIST_VIEW_OPTIONS 一致）：Nuxt UI 的 USelect
 * 的 `items` 不接受 readonly 数组。
 */
export const SYNC_WINDOW_CHOICES: Array<{ label: string, value: number }> = [
  { label: '最近 1 天', value: 1 },
  { label: '最近 3 天', value: 3 },
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '不限时间', value: 0 }
]

/** 规范化窗口天数：只接受档位内的值，非法值（手改 localStorage / 旧版本）回退默认 */
export function normalizeSyncWindowDays(raw: unknown): number {
  // 只认数字与非空数字字符串：Number(null) / Number([]) / Number('') 都是 0，
  // 直接 Number() 会把「脏值」静默当成「不限时间」（最费流量的那一档）
  const num = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(num)) return DEFAULT_SYNC_WINDOW_DAYS
  return SYNC_WINDOW_CHOICES.some(c => c.value === num) ? num : DEFAULT_SYNC_WINDOW_DAYS
}

/**
 * 读取当前设置的同步窗口天数（localStorage 里的 app-settings）。
 *
 * 直接读持久化值而不走 useSettings/useState：这里在每次复制开头被调用（一轮同步可达
 * 数百次），不值得为它把 Nuxt 的组件上下文引进 usePouchDb；设置在保存时已落盘，读到的
 * 就是最新值。SSR 下没有 localStorage，一律返回默认值。
 */
export function currentSyncWindowDays(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_SYNC_WINDOW_DAYS
  try {
    const raw = JSON.parse(localStorage.getItem('app-settings') ?? '{}') as { syncWindowDays?: unknown }
    return normalizeSyncWindowDays(raw.syncWindowDays)
  } catch {
    return DEFAULT_SYNC_WINDOW_DAYS
  }
}

/** 窗口锚点表：key 见 anchorKey，值是该源的 publishedAt 下界（ISO） */
export type WindowAnchorMap = Record<string, string>

/** 锚点表的 key：同一个源在不同窗口档位下各有一条锚点（= 各自一条 checkpoint 线） */
export function anchorKey(feedId: string, days: number): string {
  return `${feedId}|${days}`
}

/**
 * 取某个源在当前窗口下的锚点；没有就按 now - days 生成一个。
 *
 * 返回值里的 `isNew` 让调用方知道要不要把表写回 localStorage（只有新生成才写）。
 * days <= 0（不限时间）返回 null —— 不加过滤，退回改动前的全量复制。
 */
export function resolveWindowAnchor(
  key: string,
  days: number,
  anchors: WindowAnchorMap,
  now: number = Date.now()
): { anchor: string | null, isNew: boolean } {
  if (days <= 0) return { anchor: null, isNew: false }
  const hit = anchors[key]
  if (hit) return { anchor: hit, isNew: false }
  const anchor = new Date(now - days * DAY_MS).toISOString()
  anchors[key] = anchor
  return { anchor, isNew: true }
}

/**
 * 复制用的 Mango selector：只放行窗口内的条目 + 全部元数据文档。
 *
 * 两个子句缺一不可：
 *   - `{ type: 'feed' }`：FeedDoc（标题、图标）必须同步，否则本地列表没有源名与图标；
 *   - `{ publishedAt: { $gte: anchor } }`：条目按发布时间卡窗口。
 * 发布时间缺失或不可解析的条目会被挡住（`publishedAt` 落库前统一过 toIso，正常数据不会命中）。
 *
 * 键顺序是**稳定性的一部分**：复制 id 由 JSON.stringify(selector) 参与计算，
 * 换个顺序就等于换了一条 checkpoint。改这里必须知道自己在作废全部本地 checkpoint。
 */
export function windowSelector(anchor: string | null): Record<string, unknown> | undefined {
  if (!anchor) return undefined
  return {
    $or: [
      { type: 'feed' },
      { publishedAt: { $gte: anchor } }
    ]
  }
}
