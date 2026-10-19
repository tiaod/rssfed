import { Hono } from "hono"
import type { Context, Next } from "hono"
import { auth } from "../auth"
import { envInt } from "../env"
import {
  DEFAULT_TIMELINE_SETTINGS,
  getTimelineSettings,
  parseTimelineSettingsPatch,
  readTimelineUpdateSeq,
  reconcileUserTimeline,
  updateTimelineSettings,
  waitForSync,
} from "../services/timeline"
import {
  clearTimelineEvents,
  listTimelineEvents,
  listTimelineSources,
  readReconcileHeartbeat,
} from "../services/timeline-events"
import { enqueueSourceSyncs, waitForSourceSyncs } from "../workers/timeline-sync"
import { enqueueTimelineRebuild, enqueueTimelineReconcile } from "../workers/timeline"
import { resumeTimelineUser, touchTimelineActivity } from "../services/timeline-lifecycle"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/** 本路由的挂载点（app.ts 用同一常量注册） */
export const TIMELINE_ROUTE_PREFIX = "/api/timeline"

/**
 * 带 `wait=1` 的刷新请求里，服务端最多等多久（毫秒）。
 *
 * 手动同步要一个确定答案，但 HTTP 请求不能无限期挂着：一次「新订阅了上百个源、窗口内历史
 * 都要回填」的同步会远超这个值（单源复制几十毫秒到几秒，几百个源受队列并发限制要几分钟）。
 * 超时后那批同步继续在后台跑完，客户端按「仍在聚合」提示即可。
 */
const TIMELINE_REFRESH_WAIT_MS = envInt("TIMELINE_REFRESH_WAIT_MS", 15_000)

export const timelineRouter = new Hono<{ Variables: Variables }>()

/**
 * 用户时间线聚合的设置与刷新接口。
 *
 * 客户端的同步模型：对 `user-timeline_*` 库做**单向 live 复制**（服务端一写就自动到端），
 * 所以本路由不返回任何条目数据 —— 它只负责两件事：
 *   1. 读写「服务端该怎么替这个用户聚合」的设置（窗口、AI 开关）；
 *   2. 在订阅/退订/打开应用时催一次聚合（`POST /refresh`），让新内容尽快进派生库。
 */

timelineRouter.use("/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  const userId = session.user.id
  c.set("userId", userId)

  // 活跃度上报（写库有节流，见 services/timeline-lifecycle.ts）：只影响休眠判定，
  // 失败不能让请求挂掉，所以不 await 错误。
  void touchTimelineActivity(userId)

  // 休眠用户回来了：清暂停标记 + 置 needsRebuild，入队重建。重建完成前不做增量
  //（暂停期间源库墓碑可能已被 GC 清掉，增量会漏删，见 workers/timeline.ts）。
  if (await resumeTimelineUser(userId)) {
    console.log(`[Timeline] user=${userId} 休眠后恢复，已入队重建`)
    await enqueueTimelineRebuild(userId)
  }

  await next()
})

/** 读取当前设置（顺带下发默认值，客户端不必硬编码一份） */
timelineRouter.get("/settings", async (c) => {
  const settings = await getTimelineSettings(c.get("userId"))
  return c.json({ settings, defaults: DEFAULT_TIMELINE_SETTINGS })
})

/**
 * 更新设置。条目内容与保留策略只由源库裁剪决定，不随用户设置变化；改完让聚合跑一轮即可。
 */
timelineRouter.patch("/settings", async (c) => {
  const userId = c.get("userId")
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }

  const { patch, errors } = parseTimelineSettingsPatch(body)
  if (errors.length > 0) return c.json({ error: "invalid_settings", details: errors }, 400)
  if (Object.keys(patch).length === 0) return c.json({ error: "empty_patch" }, 400)

  const { settings } = await updateTimelineSettings(userId, patch)
  await enqueueTimelineReconcile(userId)

  return c.json({ settings })
})

/**
 * 催一次聚合：订阅/退订/OPML 导入后，以及「同步」按钮按下时调用。
 *
 * 两种模式：
 *   - 默认（即发即忘）：入队后立刻 202。数据由派生库的 live 复制到端，客户端不该等 ——
 *     等待会把「几百个源里的那几个有更新的」变成一次阻塞式请求。
 *   - `?wait=1`：本请求内把拓扑对齐（新订阅/退订/换窗口在这一步生效）、把脏源交给同步队列，
 *     然后**等这批单源同步跑完**并数出确切的「本轮新增 N 条」。手动同步（用户点了按钮）用这个
 *     模式，才能给出「同步完成 / 已是最新」的确定结论；等待有上限（TIMELINE_REFRESH_WAIT_MS），
 *     超时就返回 completed=false，而同步仍在后台继续 —— 客户端按「服务端仍在聚合」处理即可。
 *   - `?force=1`：跳过水位判定，把该用户当前订阅的源**全部**重扫一遍。默认路径只在
 *     「源那边上次同步之后有过新内容」时才搬，而外部直接往源库写过东西（脚本验证、人工排查）
 *     是不会体现在 `feeds/bots.lastNewEntryAt` 上的，这时需要显式重扫。**客户端不发送它**：
 *     600+ 个源全量重扫是分钟级的机器负载，属于运维/验证手段。
 */
timelineRouter.post("/refresh", async (c) => {
  const userId = c.get("userId")
  const force = c.req.query("force") === "1"

  if (c.req.query("wait") !== "1") {
    await enqueueTimelineReconcile(userId, { force })
    return c.json({ accepted: true, completed: false }, 202)
  }

  // 留给最后"数一下到底进来多少条"的预算：任务跑完后派生库已经写好了，这段只是把这段
  // 时间窗口内的 `_changes` 读一遍，几百毫秒就够（超时上限因此最多被撑出这么一点）
  const countBudgetMs = 2500
  const deadline = Date.now() + TIMELINE_REFRESH_WAIT_MS

  // 起始序号必须在**入队之前**取：等任务跑完再取的话，条目早就写进去了，会数成 0
  const since = await readTimelineUpdateSeq(userId)

  // 拓扑对齐本身很轻（列一次订阅 + 一条水位 SQL，稳态下没有脏源就一个复制请求都不发）
  const result = await reconcileUserTimeline(userId, { force })
  const jobs = await enqueueSourceSyncs(userId, result.dirtySources)
  const drained = await waitForSourceSyncs(jobs, deadline - countBudgetMs)

  const sync = await waitForSync(userId, Math.max(countBudgetMs, deadline - Date.now()), {
    sinceSeq: since,
    quietRounds: 1,
    pollIntervalMs: 300,
    minWaitMs: 0,
  })
  return c.json({
    accepted: true,
    completed: drained && sync.completed,
    added: sync.added,
    sources: result.sources,
    queued: jobs.length,
  })
})

/**
 * 同步日志：给设置页的「同步日志」面板用。
 *
 * 三段数据配着看才有用 ——
 *   - `events`：**发生过什么**（干了活的汇聚、重建、首搬、失败），空转轮次不进流水；
 *   - `sources`：**现在什么样**（每个订阅源上次同步时刻与状态），直接读水位表，不落流水；
 *   - `heartbeat`：**聚合还在不在跑**（最近一轮的时刻 + 连续多少轮无事发生）。
 *
 * `limit` 只作用于 events（默认 120，最多 500）；sources 总是全量（一个用户几十上百个源，很小）。
 */
timelineRouter.get("/events", async (c) => {
  const userId = c.get("userId")
  const rawLimit = Number(c.req.query("limit") ?? 120)
  const limit = Math.min(500, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 120)
  const [events, sources, heartbeat] = await Promise.all([
    listTimelineEvents(userId, limit),
    listTimelineSources(userId),
    readReconcileHeartbeat(userId),
  ])
  return c.json({ events, sources, heartbeat })
})

/** 清空同步流水（面板上的「清空」；源状态不受影响，它读的是水位表） */
timelineRouter.delete("/events", async (c) => {
  await clearTimelineEvents(c.get("userId"))
  return c.json({ ok: true })
})

/** 重建派生库（服务端写的条目/源元信息整体删掉再全量回填；用户状态文档不动） */
timelineRouter.post("/rebuild", async (c) => {
  await enqueueTimelineRebuild(c.get("userId"))
  return c.json({ accepted: true }, 202)
})
