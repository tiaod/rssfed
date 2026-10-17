/**
 * 同步日志（设置页 → 数据 →「同步日志」）的数据形状。
 *
 * 服务端 `GET /api/timeline/events` 返回两段：
 *   - `events`：发生过什么（一轮汇聚的结论、重建、首搬、失败），服务端落流水；
 *   - `sources`：现在什么样（每个订阅源上次同步时刻与状态），读的是水位表。
 *
 * 字段与 `packages/hono-server/src/services/timeline-events.ts` 一一对应；时间在 JSON 里是
 * ISO 字符串，客户端自己格式化成本地时间。
 */

/** 流水类型（服务端还会写别的 kind，客户端一律按未知处理而不是崩掉） */
export type TimelineEventKind = "reconcile" | "rebuild" | "source-sync" | "error"

export type TimelineEventLevel = "info" | "warn" | "error"

export interface TimelineEvent {
  id: number
  /** ISO 时间 */
  at: string
  kind: string
  level: string
  /** 给人看的一句话（服务端已拼好中文） */
  message: string
  /** 结构化补充，展开看；可能是 null */
  data: Record<string, unknown> | null
}

export interface TimelineSourceState {
  /** 源 id：feedId 或 `bot:{botId}` */
  sourceId: string
  kind: "feed" | "bot"
  /** 展示名；源被删掉时是 null */
  title: string | null
  /** ISO 时间；null = 还没同步成功过 */
  syncedAt: string | null
  /** idle / syncing / error */
  status: string
  lastError: string | null
}

export interface TimelineLogPayload {
  events: TimelineEvent[]
  sources: TimelineSourceState[]
}
