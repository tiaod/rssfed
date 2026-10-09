import { Hono } from "hono"
import type { Context, Next } from "hono"
import { auth } from "../auth"
import {
  DEFAULT_TIMELINE_SETTINGS,
  TIMELINE_SETTING_LIMITS,
  getTimelineSettings,
  parseTimelineSettingsPatch,
  updateTimelineSettings,
} from "../services/timeline"
import { enqueueTimelineRebuild, enqueueTimelineReconcile } from "../workers/timeline"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/** 本路由的挂载点（app.ts 用同一常量注册） */
export const TIMELINE_ROUTE_PREFIX = "/api/timeline"

export const timelineRouter = new Hono<{ Variables: Variables }>()

/**
 * 用户时间线聚合的设置与刷新接口。
 *
 * 客户端的同步模型：对 `user-timeline_*` 库做**单向 live 复制**（服务端一写就自动到端），
 * 所以本路由不返回任何条目数据 —— 它只负责两件事：
 *   1. 读写「服务端该怎么替这个用户聚合」的设置（窗口、图片预算、AI 开关）；
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
 * 只改窗口不动派生库的内容，只是让下一次聚合按新边界回填/剪枝；
 * 改图片参数则必须重建（已聚合条目的附件是按旧参数压的），所以这里返回
 * `rebuildQueued`，让客户端知道后台正在重算、可以展示对应提示。
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

  const { settings, needsRebuild } = await updateTimelineSettings(userId, patch)
  if (needsRebuild) await enqueueTimelineRebuild(userId)
  else await enqueueTimelineReconcile(userId)

  return c.json({ settings, rebuildQueued: needsRebuild })
})

/**
 * 催一次聚合：订阅/退订/OPML 导入后，以及「同步」按钮按下时调用。
 *
 * 立即返回（202）：聚合的产物会通过派生库的 live 复制自动到端，客户端不需要等它跑完 ——
 * 等待反而会把「几百个源里的那几个有更新的」变成一次阻塞式请求。
 */
timelineRouter.post("/refresh", async (c) => {
  await enqueueTimelineReconcile(c.get("userId"))
  return c.json({ accepted: true }, 202)
})

/** 重建派生库（设置里的「重建时间线」/ 图片参数变更后的兜底入口） */
timelineRouter.post("/rebuild", async (c) => {
  await enqueueTimelineRebuild(c.get("userId"))
  return c.json({ accepted: true }, 202)
})
