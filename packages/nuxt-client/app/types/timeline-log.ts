/**
 * 同步日志（设置弹窗 → 数据 →「同步日志」）的数据形状。
 *
 * 服务端 `GET /api/timeline/events` 返回两段：
 *   - `events`：**这一轮抓到了什么**（订阅几个源、几个到期、新增/裁剪/失败各多少）；
 *   - `heartbeat`：抓取还在不在跑（最近一轮时刻 + 连续多少轮无事发生）。
 *
 * 每个源**当前**的抓取状态不在这里：新模型下它随抓取直接写在用户库的 `_local/schedule`
 * 里，由订阅列表接口（`/api/feeds/subscriptions` 的 `status` / `lastFetchedAt` /
 * `errorMessage`）读出来 —— 那是「现在什么样」，这里是「历史都干了什么」。
 *
 * 字段与 `packages/hono-server/src/services/timeline-events.ts` 一一对应；时间在 JSON 里是
 * ISO 字符串，客户端自己格式化成本地时间。
 */

export interface TimelineEvent {
  id: number
  /** ISO 时间 */
  at: string
  /**
   * 流水类型。新模型只产生 `fetch`；`reconcile` / `rebuild` / `source-sync` / `error`
   * 是旧模型留下的历史行（面板里仍按原标签显示，不会再有新行）。
   *
   * 所以这里是 `string` 而不是联合类型：服务端将来加 kind 时，客户端应当按未知处理
   * （原样显示），而不是因为类型收窄而在构建期炸掉。
   */
  kind: string
  level: string
  /** 给人看的一句话（服务端已拼好中文） */
  message: string
  /** 结构化补充，展开看；可能是 null */
  data: Record<string, unknown> | null
}

/** 抓取心跳：空转轮次只更新它，不写进 `events` 的「有内容」部分（服务端每用户一行） */
export interface TimelineHeartbeat {
  /** ISO 时间：最近一轮抓取（不论有没有事发生） */
  at: string
  /** 连续多少轮无事发生；有新增/裁剪/失败的那一轮是 0 */
  quietRounds: number
}

/**
 * 某条订阅**当前**的抓取状态（不是流水）。
 *
 * 服务端 `GET /api/timeline/events` 不再下发它：新模型下每源的抓取状态随抓取直接写在
 * 用户库的 `_local/schedule`，由订阅列表接口（`GET /api/feeds/subscriptions`）带出来。
 */
export interface TimelineSourceState {
  feedId: string
  title: string
  /** 服务端给的 active / paused / error */
  status: string
  /** 上次抓取时刻（ISO）；从没抓过时没有 */
  lastFetchedAt?: string
  /** 上次失败的原因（服务端从 schedule 的 errorStreak 拼出来） */
  errorMessage?: string
}

export interface TimelineLogPayload {
  events: TimelineEvent[]
  /** 还没跑过任何一轮抓取时是 null */
  heartbeat: TimelineHeartbeat | null
}
