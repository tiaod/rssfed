/**
 * 时间线聚合设置（**服务端**每用户一份，存在 PG 的 user_timeline_settings）。
 *
 * 服务端只按这一个用户开关执行；保留策略（源库裁剪到每源最新 N 条 + 复制镜像）是服务端
 * 行为，没有用户可调参数。浏览器只负责把用户的选择 PATCH 上去，于是设置跟着账号走
 * （换设备/换浏览器都一致），也不再和复制 checkpoint 绑死。
 *
 * **图片参数不在这里**：正文图只在抓取时按 per-feed 策略压一次（管理员在订阅源管理里调，
 * 见服务端 rss/entry-images.ts），聚合只搬运成品，用户没有可调的图片参数。
 *
 * 服务端会把自己的默认值一起下发（GET /api/timeline/settings），
 * 这里那份 `DEFAULT_TIMELINE_SETTINGS` 只在「还没拿到服务端响应」时给 UI 一个可渲染的初值。
 */

/** 每用户的时间线聚合设置（字段与服务端 services/timeline.ts 的同名同义） */
export interface TimelineSettings {
  /** 是否生成 AI 摘要（本轮只落开关，生成链路后续接入） */
  aiSummaryEnabled: boolean
}

/** 拿到服务端响应前的初值（见服务端 DEFAULT_TIMELINE_SETTINGS） */
export const DEFAULT_TIMELINE_SETTINGS: TimelineSettings = {
  aiSummaryEnabled: false
}

/**
 * 归一化服务端/缓存返回的设置：缺项与脏值一律回退默认。
 *
 * AI 开关只认真正的布尔 `true`（`"false"` 字符串、数字 1 都不能变成开启）；
 * 真正的合法性由服务端 PATCH 校验负责。
 */
export function normalizeTimelineSettings(raw: unknown): TimelineSettings {
  const input = (raw ?? {}) as Partial<Record<keyof TimelineSettings, unknown>>
  return {
    aiSummaryEnabled: input.aiSummaryEnabled === true
  }
}

/** 客户端与服务端设置是否有实质差异（决定要不要发 PATCH） */
export function timelineSettingsEqual(a: TimelineSettings, b: TimelineSettings): boolean {
  return a.aiSummaryEnabled === b.aiSummaryEnabled
}
