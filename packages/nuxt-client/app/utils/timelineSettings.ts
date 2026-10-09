/**
 * 时间线聚合设置（**服务端**每用户一份，存在 PG 的 user_timeline_settings）。
 *
 * 与旧的 syncWindow（窗口下界记在浏览器 localStorage、靠复制 selector 实现）不同：
 * 现在窗口、图片预算、AI 开关都由服务端在聚合时执行，浏览器只负责把用户的选择 PATCH 上去。
 * 于是设置跟着账号走（换设备/换浏览器都一致），也不再和复制 checkpoint 绑死。
 *
 * 服务端会把自己的默认值与合法区间一起下发（GET /api/timeline/settings），
 * 这里那份 `DEFAULT_TIMELINE_SETTINGS` 只在「还没拿到服务端响应」时给 UI 一个可渲染的初值。
 */

/** 每用户的时间线聚合设置（字段与服务端 services/timeline.ts 的同名同义） */
export interface TimelineSettings {
  /** 回填窗口天数；0 = 不限时间 */
  windowDays: number
  /** 每篇条目最多缓存几张正文图（封面不计入） */
  maxImageCount: number
  /** 每篇条目附件总体积上限（字节） */
  maxEntryImageBytes: number
  /** 压缩后最大宽度（px） */
  maxImageWidth: number
  /** AVIF 编码质量 */
  avifQuality: number
  /** 源图下载大小上限（字节） */
  maxSourceImageBytes: number
  /** 是否生成 AI 摘要（本轮只落开关，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 拿到服务端响应前的初值（见服务端 DEFAULT_TIMELINE_SETTINGS） */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  windowDays: 3,
  // 服务端的每篇图片张数默认值可以用环境变量调（MAX_IMAGE_COUNT），这里是它的默认取值；
  // 读取失败时它只是首屏占位的数字，真正生效的值一律以服务端返回为准
  maxImageCount: 200,
  maxEntryImageBytes: 1024 * 1024,
  maxImageWidth: 1200,
  avifQuality: 45,
  maxSourceImageBytes: 8 * 1024 * 1024,
  aiSummaryEnabled: false
}

/** 合法区间（服务端也会校验一遍：这里是 UI 层的即时反馈，不是唯一防线） */
export const TIMELINE_SETTING_LIMITS = {
  windowDays: { min: 0, max: 365 },
  maxImageCount: { min: 0, max: 500 },
  maxEntryImageBytes: { min: 0, max: 32 * 1024 * 1024 },
  maxImageWidth: { min: 64, max: 4096 },
  avifQuality: { min: 1, max: 100 },
  maxSourceImageBytes: { min: 64 * 1024, max: 64 * 1024 * 1024 }
} as const

/**
 * 下拉选项一律用固定档位而不是任意数字。
 *
 * 这些值直接决定服务端要下载并重压多少张图（每篇 × 每个用户），档位有限才谈得上
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

/** 每篇图片张数上限（0 = 不缓存正文图，只留协议封面） */
export const TIMELINE_IMAGE_COUNT_CHOICES: Array<{ label: string, value: number }> = [
  { label: '不缓存', value: 0 },
  { label: '最多 3 张', value: 3 },
  { label: '最多 6 张', value: 6 },
  { label: '最多 12 张', value: 12 },
  { label: '最多 20 张', value: 20 },
  { label: '不限张数（按体积预算）', value: 200 }
]

/** 每篇附件体积预算（值一律用字节，UI 只展示 MB/KB） */
export const TIMELINE_ENTRY_BYTES_CHOICES: Array<{ label: string, value: number }> = [
  { label: '128 KB', value: 128 * 1024 },
  { label: '256 KB', value: 256 * 1024 },
  { label: '512 KB', value: 512 * 1024 },
  { label: '1 MB', value: 1024 * 1024 },
  { label: '2 MB', value: 2 * 1024 * 1024 }
]

/** 压缩后宽度上限 */
export const TIMELINE_IMAGE_WIDTH_CHOICES: Array<{ label: string, value: number }> = [
  { label: '480 px', value: 480 },
  { label: '800 px', value: 800 },
  { label: '1200 px', value: 1200 },
  { label: '1600 px', value: 1600 }
]

/** AVIF 质量 */
export const TIMELINE_QUALITY_CHOICES: Array<{ label: string, value: number }> = [
  { label: '省流量（30）', value: 30 },
  { label: '均衡（45）', value: 45 },
  { label: '清晰（60）', value: 60 },
  { label: '高保真（75）', value: 75 }
]

/** 源图下载大小上限（超过即放弃，避免为一张巨图拖垮整轮聚合） */
export const TIMELINE_SOURCE_BYTES_CHOICES: Array<{ label: string, value: number }> = [
  { label: '2 MB', value: 2 * 1024 * 1024 },
  { label: '4 MB', value: 4 * 1024 * 1024 },
  { label: '8 MB', value: 8 * 1024 * 1024 },
  { label: '16 MB', value: 16 * 1024 * 1024 }
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
    maxImageCount: num('maxImageCount', DEFAULT_TIMELINE_SETTINGS.maxImageCount),
    maxEntryImageBytes: num('maxEntryImageBytes', DEFAULT_TIMELINE_SETTINGS.maxEntryImageBytes),
    maxImageWidth: num('maxImageWidth', DEFAULT_TIMELINE_SETTINGS.maxImageWidth),
    avifQuality: num('avifQuality', DEFAULT_TIMELINE_SETTINGS.avifQuality),
    maxSourceImageBytes: num('maxSourceImageBytes', DEFAULT_TIMELINE_SETTINGS.maxSourceImageBytes),
    aiSummaryEnabled: input.aiSummaryEnabled === true
  }
}

/**
 * 保证当前值一定出现在下拉项里。
 *
 * 服务端的默认值可以用环境变量调（如 `MAX_IMAGE_COUNT`），客户端不可能把所有可能取值都列成
 * 档位；而当前值不在 items 里时，Nuxt UI 的 USelect 会显示空白 —— 用户看到的是「设置丢了」，
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
    && a.maxImageCount === b.maxImageCount
    && a.maxEntryImageBytes === b.maxEntryImageBytes
    && a.maxImageWidth === b.maxImageWidth
    && a.avifQuality === b.avifQuality
    && a.maxSourceImageBytes === b.maxSourceImageBytes
    && a.aiSummaryEnabled === b.aiSummaryEnabled
}
