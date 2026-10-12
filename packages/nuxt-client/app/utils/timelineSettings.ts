/**
 * 时间线聚合设置（**服务端**每用户一份，存在 PG 的 user_timeline_settings）。
 *
 * 与旧的 syncWindow（窗口下界记在浏览器 localStorage、靠复制 selector 实现）不同：
 * 现在窗口与 AI 开关都由服务端在聚合时执行，浏览器只负责把用户的选择 PATCH 上去。
 * 于是设置跟着账号走（换设备/换浏览器都一致），也不再和复制 checkpoint 绑死。
 *
 * **图片参数不在这里**：正文图只在抓取时按 per-feed 策略压一次（管理员在订阅源管理里调，
 * 见服务端 rss/entry-images.ts），聚合只搬运成品，用户没有可调的图片参数。
 *
 * 服务端会把自己的默认值与合法区间一起下发（GET /api/timeline/settings），
 * 这里那份 `DEFAULT_TIMELINE_SETTINGS` 只在「还没拿到服务端响应」时给 UI 一个可渲染的初值。
 */

/** 每用户的时间线聚合设置（字段与服务端 services/timeline.ts 的同名同义） */
export interface TimelineSettings {
  /** 回填窗口天数；0 = 不限时间 */
  windowDays: number
  /** 每个订阅源的保底条数：滑出窗口也要留住"该源最新 N 条"；0 = 关闭 */
  minFeedEntries: number
  /** 是否生成 AI 摘要（本轮只落开关，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 拿到服务端响应前的初值（见服务端 DEFAULT_TIMELINE_SETTINGS） */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  windowDays: 3,
  minFeedEntries: 50,
  aiSummaryEnabled: false
}

/** 合法区间（服务端也会校验一遍：这里是 UI 层的即时反馈，不是唯一防线） */
export const TIMELINE_SETTING_LIMITS = {
  windowDays: { min: 0, max: 365 },
  minFeedEntries: { min: 0, max: 1000 }
} as const

/**
 * 下拉选项一律用固定档位而不是任意数字。
 *
 * 窗口直接决定服务端要扫多长的历史（以及本地要存多少条），档位有限才谈得上
 * 「这个设置大概花多少空间/时间」。类型是可变的 `{ label, value }[]`：Nuxt UI 的
 * USelect 的 `items` 不接受 readonly 数组（与 LIST_VIEW_OPTIONS 一致）。
 */
export const TIMELINE_WINDOW_CHOICES: Array<{ label: string, value: number }> = [
  { label: '最近 1 天', value: 1 },
  { label: '最近 3 天', value: 3 },
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '不限时间', value: 0 }
]

/**
 * 「每个源至少保留多少条」的档位。
 *
 * 保底条数是给**低频源**兜底的：几周才发一篇的源在纯时间窗口下永远空空如也，
 * 用户以为订阅坏了。高频源不受影响 —— 窗口内的条数本来就超过这个值。
 * 关掉（0）就回到纯时间窗口的老行为。
 */
export const TIMELINE_MIN_ENTRIES_CHOICES: Array<{ label: string, value: number }> = [
  { label: '关闭（纯时间窗口）', value: 0 },
  { label: '20 条', value: 20 },
  { label: '50 条', value: 50 },
  { label: '100 条', value: 100 },
  { label: '200 条', value: 200 }
]

/**
 * 归一化服务端/缓存返回的设置：缺项与脏值一律回退默认。
 *
 * 不做「静默夹取」到合法区间：设置本身不参与任何寻址（不像旧的窗口锚点会改变复制 id），
 * 拿到什么值就显示什么值；真正的合法性由服务端 PATCH 校验负责（越界会 400 并给出明细）。
 */
export function normalizeTimelineSettings(raw: unknown): TimelineSettings {
  const input = (raw ?? {}) as Partial<Record<keyof TimelineSettings, unknown>>
  const num = (key: keyof TimelineSettings, fallback: number): number => {
    const value = input[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    windowDays: num('windowDays', DEFAULT_TIMELINE_SETTINGS.windowDays),
    minFeedEntries: num('minFeedEntries', DEFAULT_TIMELINE_SETTINGS.minFeedEntries),
    aiSummaryEnabled: input.aiSummaryEnabled === true
  }
}

/**
 * 保证当前值一定出现在下拉项里。
 *
 * 服务端的默认值可以用环境变量/代码调，客户端不可能把所有可能取值都列成档位；
 * 而当前值不在 items 里时，Nuxt UI 的 USelect 会显示空白 —— 用户看到的是「设置丢了」，
 * 比看到一个不认识的档位糟糕得多。所以缺档时补一项（标签由调用方给出，带单位）。
 */
export function withCurrentChoice(
  items: Array<{ label: string, value: number }>,
  value: number,
  label: string
): Array<{ label: string, value: number }> {
  if (items.some(item => item.value === value)) return items
  return [...items, { label: `${label}（${value}）`, value }].sort((a, b) => a.value - b.value)
}

/** 客户端与服务端设置是否有实质差异（决定要不要发 PATCH） */
export function timelineSettingsEqual(a: TimelineSettings, b: TimelineSettings): boolean {
  return a.windowDays === b.windowDays
    && a.minFeedEntries === b.minFeedEntries
    && a.aiSummaryEnabled === b.aiSummaryEnabled
}
