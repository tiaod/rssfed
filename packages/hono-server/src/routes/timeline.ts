import { Hono } from "hono"
import type { Context, Next } from "hono"
import { auth } from "../auth"
import {
  DEFAULT_TIMELINE_SETTINGS,
  TIMELINE_SETTING_LIMITS,
  getTimelineSettings,
  parseTimelineSettingsPatch,
  reconcileUserTimeline,
  updateTimelineSettings,
} from "../services/timeline"
import { enqueueTimelineRebuild, enqueueTimelineReconcile } from "../workers/timeline"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/** 本路由的挂载点（app.ts 用同一常量注册） */
export const TIMELINE_ROUTE_PREFIX = "/api/timeline"

/**
 * 带 `wait=1` 的刷新请求里，服务端最多等多久（毫秒）。
 *
 * 手动同步要一个确定答案，但 HTTP 请求不能无限期挂着：一轮完整的 reconcile 在
 * 「新订阅了上百个源、窗口内历史都要回填」时可能远超这个值。超时后那轮聚合继续在后台
 * 跑完，客户端按「仍在聚合」提示即可（见 routes/timeline.ts 的 /refresh）。
 */
const TIMELINE_REFRESH_WAIT_MS = parseInt(process.env.TIMELINE_REFRESH_WAIT_MS ?? "15000")

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
  c.set("userId", session.user.id)
  await next()
})

/** 读取当前设置（顺带下发默认值与合法区间，客户端不必硬编码一份） */
timelineRouter.get("/settings", async (c) => {
  const settings = await getTimelineSettings(c.get("userId"))
  return c.json({ settings, defaults: DEFAULT_TIMELINE_SETTINGS, limits: TIMELINE_SETTING_LIMITS })
})

/**
 * 更新设置。
 *
 * 改窗口不需要重建：窗口是「回填/剪枝」的边界，由下一次聚合自己处理（缩小剪枝、放大回填），
 * 所以入队一次增量聚合即可。条目内容与附件只由源库决定，不随用户设置变化。
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
 *   - `?wait=1`：**本请求内**跑完一轮 reconcile 再返回，附上确切的「本轮新增 N 条」。
 *     手动同步（用户点了按钮）用这个模式，才能给出「同步完成 / 已是最新」的确定结论；
 *     服务端等待有上限（TIMELINE_REFRESH_WAIT_MS），超时就返回 completed=false，
 *     而那轮 reconcile 仍在后台跑完 —— 客户端按「服务端仍在聚合」处理即可，不算失败。
 */
timelineRouter.post("/refresh", async (c) => {
  const userId = c.get("userId")

  if (c.req.query("wait") !== "1") {
    await enqueueTimelineReconcile(userId)
    return c.json({ accepted: true, completed: false }, 202)
  }

  const running = reconcileUserTimeline(userId)
  const result = await Promise.race([
    running,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), TIMELINE_REFRESH_WAIT_MS)
      // 不因这个计时器拖着进程不退出（服务器优雅关闭时尤其重要）
      timer.unref?.()
    }),
  ])
  if (!result) {
    // 超时：上面那轮 reconcile 没有被取消，会自己跑完（数据随后由 live 复制到端），
    // 所以这里**不能**再入队一轮 —— 那只会让同一份工作同时跑两遍
    return c.json({ accepted: true, completed: false }, 202)
  }
  return c.json({
    accepted: true,
    completed: true,
    added: result.addedEntries,
    sources: result.sources,
  })
})

/** 重建派生库（服务端写的条目/源元信息整体删掉再全量回填；用户状态文档不动） */
timelineRouter.post("/rebuild", async (c) => {
  await enqueueTimelineRebuild(c.get("userId"))
  return c.json({ accepted: true }, 202)
})
