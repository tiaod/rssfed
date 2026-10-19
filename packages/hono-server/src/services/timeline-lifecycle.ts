/**
 * 用户时间线聚合的**生命周期**：活跃度上报、休眠暂停、恢复重建。
 *
 * 为什么要休眠：服务端每 5 分钟给**所有**用户入队一轮 reconcile，僵尸用户（注册后再也没
 * 登录）也照样占着聚合队列、每 5 分钟空转、源有更新时还要往他的派生库里复一份。更关键的是
 * **源库墓碑 GC 的安全窗**：只要有一个订阅者的水位停在旧位置，那个源的墓碑就永远清不掉。
 * 所以长期不活跃的账号要显式"停聚合"，GC 把它当成没有订阅者。
 *
 * 为什么恢复时**重建**而不是补增量：暂停期间源库的墓碑可能已经被 GC 清掉，增量复制拿不到
 * 期间的删除 → 派生库会永久留着该删的条目。重建 = 换空库重搬当前活文档，天然一致。
 * 这也是 GC 敢忽略休眠用户的原因：他们回来时本来就会重算。
 *
 * 顺带一个必须成立的次序：恢复后**先重建、不做增量**。`needsRebuild` 就是那个闸门
 * （见 workers/timeline.ts：reconcile 见到它只入队 rebuild）。
 */
import { and, eq, isNull, sql } from "drizzle-orm"
import { db, user, session, userTimelineSettings } from "../db"

/** 活跃度上报的写库节流：同一个用户一小时内最多写一次 `last_active_at` */
const ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1000
const activityWriteCache = new Map<string, number>()

/** 测试用：清掉进程内节流缓存，避免用例之间互相影响 */
export function resetTimelineActivityThrottle(): void {
  activityWriteCache.clear()
}

export interface TimelineUserState {
  lastActiveAt: Date | null
  aggregationPausedAt: Date | null
  needsRebuild: boolean
}

/**
 * 记录"这个用户最近还在用时间线"。
 *
 * 调用点在 timeline 路由的鉴权中间件里（客户端打开列表就会 `POST /refresh`），写库有节流；
 * 失败不影响请求（活跃度只影响休眠判定，不能因为一次 PG 抖动把用户请求打挂）。
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

/** 读用户的生命周期状态（没有行 = 默认值：从未活跃、未休眠、不需要重建） */
export async function readTimelineUserState(userId: string): Promise<TimelineUserState> {
  const [row] = await db.select({
    lastActiveAt: userTimelineSettings.lastActiveAt,
    aggregationPausedAt: userTimelineSettings.aggregationPausedAt,
    needsRebuild: userTimelineSettings.needsRebuild,
  }).from(userTimelineSettings).where(eq(userTimelineSettings.userId, userId)).limit(1)
  return {
    lastActiveAt: row?.lastActiveAt ?? null,
    aggregationPausedAt: row?.aggregationPausedAt ?? null,
    needsRebuild: row?.needsRebuild ?? false,
  }
}

/**
 * 用户"回来了"：清掉休眠标记、置 `needsRebuild`，返回是否真的发生了恢复。
 *
 * 调用方（timeline 路由中间件）在返回 true 时入队一次重建。用**条件 UPDATE** 而不是
 * 先读后写：多标签页/多设备同时回来时只有一个请求会拿到 true，不会重复入队重建。
 */
export async function resumeTimelineUser(userId: string): Promise<boolean> {
  const rows = await db.update(userTimelineSettings)
    .set({ aggregationPausedAt: null, needsRebuild: true })
    .where(and(
      eq(userTimelineSettings.userId, userId),
      sql`${userTimelineSettings.aggregationPausedAt} is not null`,
    ))
    .returning({ userId: userTimelineSettings.userId })
  return rows.length > 0
}

/** 重建成功后清掉闸门（失败则由调度器下一轮继续入队重建） */
export async function markTimelineRebuildDone(userId: string): Promise<void> {
  await db.update(userTimelineSettings)
    .set({ needsRebuild: false })
    .where(and(
      eq(userTimelineSettings.userId, userId),
      eq(userTimelineSettings.needsRebuild, true),
    ))
}

/** 定时聚合的目标：跳过休眠用户；需要重建的用户走重建而不是增量 */
export interface TimelineScheduleTarget {
  userId: string
  needsRebuild: boolean
}

export async function listTimelineScheduleTargets(): Promise<TimelineScheduleTarget[]> {
  const rows = await db.select({
    userId: user.id,
    needsRebuild: userTimelineSettings.needsRebuild,
  })
    .from(user)
    .leftJoin(userTimelineSettings, eq(user.id, userTimelineSettings.userId))
    // 休眠用户不参与定时聚合；其余用户全量保留（零订阅用户空转成本只有一条 SQL）
    .where(isNull(userTimelineSettings.aggregationPausedAt))
  return rows.map((row) => ({ userId: row.userId, needsRebuild: Boolean(row.needsRebuild) }))
}

/**
 * 把长期不活跃的用户标成"暂停聚合"。
 *
 * 活跃度判定按优先级：本服务记录的 `last_active_at` → Better Auth 的会话最近更新时间 →
 * 账号创建时间。用会话兜底是为了功能刚上线时 `last_active_at` 还全是空：至少不会把
 * 三年没登录的账号当成"刚刚注册"、也不会把一直登录的用户误判成僵尸。
 *
 * 只处理**有水位行**的用户（订阅过东西才值得暂停；零订阅用户暂停没有收益，只是多落一行）。
 *
 * @param days 多少天没活动算休眠（<=0 = 关闭）
 * @returns 本次新暂停的用户 id
 */
export async function pauseDormantUsers(
  days: number,
  options: { now?: Date, limit?: number } = {},
): Promise<string[]> {
  if (!Number.isFinite(days) || days <= 0) return []
  const now = options.now ?? new Date()
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000))

  // 直接用 SQL：需要 join 会话表的最大时间 + 半开区间比较，用查询构造器反而更难读。
  // `now` 走参数（便于测试注入），显式转成 UTC 的 timestamp 与库里的列比较（列是 timestamp
  // without time zone，存的就是 UTC；不显式转的话 postgres.js 不接受 Date 作为原始参数）。
  const cutoff = sql`(cast(${now.toISOString()} as timestamptz) at time zone 'UTC')`
  const result = await db.execute(sql`
    select u.id as user_id
    from "user" u
    left join user_timeline_settings s on s.user_id = u.id
    left join (
      select user_id, max(coalesce(updated_at, created_at)) as last_seen
      from ${session}
      group by user_id
    ) se on se.user_id = u.id
    where s.aggregation_paused_at is null
      and coalesce(s.needs_rebuild, false) = false
      and coalesce(s.last_active_at, se.last_seen, u.created_at) < ${cutoff} - make_interval(days => ${Math.floor(days)})
      and exists (select 1 from timeline_source_sync t where t.user_id = u.id)
    limit ${limit}
  `) as unknown as Array<{ user_id: string }>

  const userIds = result.map((row) => row.user_id).filter(Boolean)
  if (userIds.length === 0) return []

  // 大部分用户没有 settings 行：必须 upsert（只 UPDATE 会漏掉他们，僵尸账号永远停不下来）
  const paused = await db.insert(userTimelineSettings)
    .values(userIds.map((userId) => ({ userId, aggregationPausedAt: now })))
    .onConflictDoUpdate({
      target: userTimelineSettings.userId,
      set: { aggregationPausedAt: now },
    })
    .returning({ userId: userTimelineSettings.userId })
  return paused.map((row) => row.userId)
}
