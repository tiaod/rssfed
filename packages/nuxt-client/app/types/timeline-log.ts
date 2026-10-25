/**
 * 同步日志（设置页 → 数据 →「同步日志」）的数据形状。
 *
 * 服务端 `GET /api/timeline/events` 返回三段：
 *   - `events`：发生过什么（干了活的汇聚、重建、首搬、失败），空转轮次不进流水；
 *   - `sources`：现在什么样（每个订阅源上次同步时刻与状态），读的是水位表；
 *   - `heartbeat`：聚合还在不在跑（最近一轮时刻 + 连续多少轮无事发生）。
 *
 * 字段与 `packages/hono-server/src/services/timeline-events.ts` 一一对应；时间在 JSON 里是
 * ISO 字符串，客户端自己格式化成本地时间。
 */

/** 流水类型（服务端还会写别的 kind，客户端一律按未知处理而不是崩掉） */
export type TimelineEventKind = 'reconcile' | 'rebuild' | 'source-sync' | 'error'

export type TimelineEventLevel = 'info' | 'warn' | 'error'

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
  kind: 'feed' | 'bot'
  /** 展示名；源被删掉时是 null */
  title: string | null
  /** ISO 时间；null = 还没同步成功过 */
  syncedAt: string | null
  /** idle / syncing / error */
  status: string
  lastError: string | null
}

/** 聚合心跳：空转轮次只更新它，不写流水（服务端每用户一行） */
export interface TimelineHeartbeat {
  /** ISO 时间：最近一轮聚合（不论有没有事发生） */
  at: string
  /** 连续多少轮无事发生；有搬运/清理/失败的那一轮是 0 */
  quietRounds: number
}

export interface TimelineLogPayload {
  events: TimelineEvent[]
  sources: TimelineSourceState[]
  /** 还没跑过任何一轮聚合时是 null */
  heartbeat: TimelineHeartbeat | null
}
