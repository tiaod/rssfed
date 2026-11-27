import { Hono } from "hono"
import type { Context, Next } from "hono"
import { auth } from "../auth"
import { envInt } from "../env"
import {
  DEFAULT_TIMELINE_SETTINGS,
  getTimelineSettings,
  parseTimelineSettingsPatch,
  readTimelineUpdateSeq,
  updateTimelineSettings,
  waitForSync,
} from "../services/timeline"
import {
  clearTimelineEvents,
  listTimelineEvents,
  readReconcileHeartbeat,
} from "../services/timeline-events"
import { enqueueOwnerSubscriptions, type FetchOwnerJob } from "../workers"
import { resumeOwner } from "../services/owner-platform"
import { touchTimelineActivity } from "../services/timeline-lifecycle"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/** 本路由的挂载点（app.ts 用同一常量注册） */
export const TIMELINE_ROUTE_PREFIX = "/api/timeline"

/**
 * 带 `wait=1` 的刷新请求里，服务端最多等多久（毫秒）。
 *
 * 手动同步要一个确定答案，但 HTTP 请求不能无限期挂着：一次「新订阅了上百个源」会远超这个值
 * （单源抓取几十毫秒到几秒，几百个源受并发限制要几分钟）。超时后那批抓取继续在后台跑完，
 * 客户端按「仍在抓取」提示即可。
 */
const TIMELINE_REFRESH_WAIT_MS = envInt("TIMELINE_REFRESH_WAIT_MS", 15_000)

export const timelineRouter = new Hono<{ Variables: Variables }>()

/**
 * 用户时间线的设置与刷新接口。
 *
 * 客户端的同步模型：对 `user-timeline_*` 库做**单向 live 复制**（服务端一写就自动到端），
 * 所以本路由不返回任何条目数据 —— 它只负责两件事：
 *   1. 读写「服务端该怎么替这个用户抓取」的设置；
 *   2. 在订阅/退订/打开应用时催一次抓取（`POST /refresh`），让新内容尽快进库。
 */
timelineRouter.use("/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  const userId = session.user.id
  c.set("userId", userId)

  // 活跃度上报（写库有节流，见 services/timeline-lifecycle.ts）：只影响休眠判定，
  // 失败不能让请求挂掉，所以不 await 错误。
  void touchTimelineActivity(userId)

  // 休眠用户回来了：清掉休眠标记。不需要任何重建 —— 下一轮抓取自然把内容补上。
  if (await resumeOwner(userId).catch(() => false)) {
    console.log(`[Timeline] user=${userId} 休眠后恢复，已重新纳入调度`)
  }

  await next()
})

/** 读取当前设置（顺带下发默认值，客户端不必硬编码一份） */
timelineRouter.get("/settings", async (c) => {
  const settings = await getTimelineSettings(c.get("userId"))
  return c.json({ settings, defaults: DEFAULT_TIMELINE_SETTINGS })
})

/** 更新设置。条目内容与保留策略不随用户设置变化；改完让抓取跑一轮即可。 */
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
  return c.json({ settings })
})

/**
 * 催一次抓取：订阅/退订/OPML 导入后，以及「同步」按钮按下时调用。
 *
 * 两种模式：
 *   - 默认（即发即忘）：入队后立刻 202。数据由用户库的 live 复制到端，客户端不该等 ——
 *     等待会把「几百个源里的那几个有更新的」变成一次阻塞式请求。
 *   - `?wait=1`：本请求内把该用户的全部订阅入队，然后**等库安静下来**并数出确切的
 *     「本轮新增 N 条」。手动同步（用户点了按钮）用这个模式，才能给出确定结论；
 *     等待有上限（TIMELINE_REFRESH_WAIT_MS），超时就返回 completed=false，
 *     而抓取仍在后台继续 —— 客户端按「服务端仍在抓取」处理即可。
 *   - `?force=1`：强制抓取（绕开缓存与"上次刚抓过"的判定）。供运维/验证使用，
 *     **客户端不发送它**：几百个源同时真正发请求是分钟级的机器负载。
 */
timelineRouter.post("/refresh", async (c) => {
  const userId = c.get("userId")
  const force = c.req.query("force") === "1"
  const owner: FetchOwnerJob = { kind: "user", id: userId }

  if (c.req.query("wait") !== "1") {
    const queued = await enqueueOwnerSubscriptions(owner, { bypassCache: force })
    return c.json({ accepted: true, completed: false, queued }, 202)
  }

  // 留给最后"数一下到底进来多少条"的预算：任务跑完后条目已经写好了，这段只是把这段时间
  // 窗口内的 `_changes` 读一遍，几百毫秒就够（超时上限因此最多被撑出这么一点）
  const countBudgetMs = 2500
  const deadline = Date.now() + TIMELINE_REFRESH_WAIT_MS

  // 起始序号必须在**入队之前**取：等任务跑完再取的话，条目早就写进去了，会数成 0
  const since = await readTimelineUpdateSeq(userId)

  const queued = await enqueueOwnerSubscriptions(owner, { bypassCache: force })
  const sync = await waitForSync(userId, Math.max(countBudgetMs, deadline - Date.now()), {
    sinceSeq: since,
    // 抓取是并发的，条目会陆续写进来：要允许它"多安静几轮"才算追平
    quietRounds: 8,
    pollIntervalMs: 300,
    minWaitMs: 0,
  })
  return c.json({
    accepted: true,
    completed: sync.completed,
    added: sync.added,
    queued,
  })
})

/**
 * 同步日志：给设置页的「同步日志」面板用。
 *
 * 两段数据配着看才有用 ——
 *   - `events`：**这一轮抓到了什么**（订阅几个源、几个到期、新增/裁剪/失败各多少），
 *     空转轮次也记一条（能区分「没触发调度」和「触发了但所有源都没到期」）；
 *   - `heartbeat`：**抓取还在不在跑**（最近一轮的时刻 + 连续多少轮无事发生）。
 *
 * 每个源**当前**的抓取状态（上次抓取时刻、失败原因）不在这里：它随抓取直接写在用户库的
 * `_local/schedule` 里，用户订阅列表接口（`GET /api/feeds/subscriptions`）会带出来。
 */
timelineRouter.get("/events", async (c) => {
  const userId = c.get("userId")
  const rawLimit = Number(c.req.query("limit") ?? 120)
  const limit = Math.min(500, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 120)
  const [events, heartbeat] = await Promise.all([
    listTimelineEvents(userId, limit),
    readReconcileHeartbeat(userId),
  ])
  return c.json({ events, heartbeat })
})

/** 清空同步流水（面板上的「清空」；心跳不受影响） */
timelineRouter.delete("/events", async (c) => {
  await clearTimelineEvents(c.get("userId"))
  return c.json({ ok: true })
})

/**
 * 立即重新抓取当前用户的全部订阅（设置页的「重新同步」按钮）。
 *
 * 与 `POST /refresh?force=1` 等价，保留这个路径是因为前端已经在调它。
 */
timelineRouter.post("/rebuild", async (c) => {
  const userId = c.get("userId")
  const queued = await enqueueOwnerSubscriptions({ kind: "user", id: userId }, { bypassCache: true })
  return c.json({ accepted: true, queued }, 202)
})
