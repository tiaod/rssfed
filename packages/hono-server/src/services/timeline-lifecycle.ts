/**
 * 用户活跃度上报 —— 休眠判定的唯一输入。
 *
 * ## 为什么要休眠
 *
 * 服务端每隔一段时间枚举**所有** owner 的订阅并给到期的源入队。僵尸用户（注册后再也没登录）
 * 的源也会一直被轮询，白花 egress 与 CouchDB 写入。
 *
 * ## 新模型下休眠比旧模型简单得多
 *
 * 旧模型里"暂停聚合"还牵扯到源库墓碑 GC 的安全窗与恢复时的换库重搬；
 * 现在每个用户只抓自己的东西、用户库就是唯一真相，所以休眠只是**不再抓**，
 * 回来时下一轮调度照常抓、缺的内容随那次抓取补上。没有 `needsRebuild` 这回事了。
 */
import { eq } from "drizzle-orm"
import { db, userTimelineSettings } from "../db"

/** 活跃度上报的写库节流：同一个用户一小时内最多写一次 `last_active_at` */
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1000
const activityWriteCache = new Map<string, number>()

/** 测试用：清掉进程内节流缓存，避免用例之间互相影响 */
export function resetTimelineActivityThrottle(): void {
  activityWriteCache.clear()
}

/**
 * 记录"这个用户最近还在用"。
 *
 * 调用点在 timeline 路由的鉴权中间件里（客户端打开列表就会打接口），写库有节流；
 * 失败不影响请求 —— 活跃度只影响休眠判定，不能因为一次 PG 抖动把用户请求打挂。
 */
export async function touchTimelineActivity(userId: string, now: number = Date.now()): Promise<void> {
  const last = activityWriteCache.get(userId)
  if (last !== undefined && now - last < ACTIVITY_WRITE_INTERVAL_MS) return
  activityWriteCache.set(userId, now)
  // 缓存涨到一定量就清一遍，防止进程长期运行时 Map 无限增长（条目很小，阈值取大）
  if (activityWriteCache.size > 10_000) {
    for (const [key, at] of activityWriteCache) {
      if (now - at >= ACTIVITY_WRITE_INTERVAL_MS) activityWriteCache.delete(key)
    }
  }
  try {
    await db.insert(userTimelineSettings)
      .values({ userId, lastActiveAt: new Date(now) })
      .onConflictDoUpdate({
        target: userTimelineSettings.userId,
        set: { lastActiveAt: new Date(now) },
      })
  } catch (err) {
    activityWriteCache.delete(userId)
    console.warn("[Timeline] 活跃度上报失败（下一轮重试）：", (err as Error)?.message ?? err)
  }
}
