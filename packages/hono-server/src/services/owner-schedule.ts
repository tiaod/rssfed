import { createCouchDb } from "../couchdb/client"

/**
 * 每个 owner 库里的 `_local/schedule` 文档 —— 抓取调度状态与每源保留条数的**唯一存放处**。
 *
 * ## 为什么是 `_local`
 *
 * `_local` 文档**不参与复制**：浏览器不会同步到「服务端啥时候抓过这个源」这种纯内部状态，
 * 也不会在客户端看到一个自己改不了、还会被服务端反复覆盖的文档。它同时随库一起删除，
 * 所以「换库 = 状态归零」天然成立。
 *
 * ## 为什么不放回 PostgreSQL
 *
 * 新模型里调度输入是 **(owner, feedId)** 维度的：`lastFetchedAt` / `errorStreak` /
 * `retentionEntries` 全都只对某个人订阅的某个源有意义。放 PG 就是又一张按用户切分的投影表，
 * 而它唯一的好处（能按源反查所有人）在这个模型里已经不存在了 —— 没有扇出要反查。
 *
 * ## 为什么整库一个文档而不是每源一个
 *
 * 每源一个 `_local/sched:{feedId}` 的话，一轮调度要为 600 个源发 600 次 GET；
 * 整库一个文档是一次 GET。代价是写放大（每个抓取完成都要重写整份 map），但写入是
 * **单写者**（同一 owner 的抓取 job 串行度由 BullMQ 的 jobId 保证同一 (owner, feedId)
 * 不会并发，而不同源之间的并发写会互相覆盖 —— 见下面的 mergeSchedule 说明）。
 */

/** 文档 id（`_local/` 前缀，不参与复制） */
export const SCHEDULE_DOC_ID = "_local/schedule"

/** schedule 文档的版本：结构变化时 +1，读到旧版本按空状态处理 */
export const SCHEDULE_VERSION = 1

/** 单个源的调度状态 */
export interface SourceScheduleEntry {
  /** 上次成功抓取（200 或 304）的时刻 */
  lastFetchedAt?: string
  /** 上次抓到**新条目**的时刻；自适应降频按它算 */
  lastNewEntryAt?: string
  /** 上次抓取失败的最近时刻（失败也算一次抓取，否则坏源会被每轮重试） */
  lastErrorAt?: string
  /** 连续失败次数（成功一次归零，调度器按它指数退避） */
  errorStreak?: number
  /** 上次响应是否带条件请求验证器（无验证器的源降频更激进，见 workers/fetch-schedule.ts） */
  hasValidators?: boolean
  /** 该源在这个库里保留多少条（自适应算出；null/缺失 = 全局默认） */
  retentionEntries?: number | null
  /** 用户暂停了这条订阅（镜像订阅文档的 paused，供调度快速判断） */
  paused?: boolean
}

export interface ScheduleState {
  version: number
  /** feedId → 状态 */
  sources: Record<string, SourceScheduleEntry>
}

export function emptySchedule(): ScheduleState {
  return { version: SCHEDULE_VERSION, sources: {} }
}

/** 读 schedule 文档；不存在或版本不符返回空状态 */
export async function readSchedule(dbName: string): Promise<ScheduleState> {
  const db = createCouchDb(dbName)
  try {
    const doc = await db.get(SCHEDULE_DOC_ID) as Partial<ScheduleState> & { _rev?: string }
    if (doc?.version !== SCHEDULE_VERSION || typeof doc.sources !== "object" || !doc.sources) {
      return emptySchedule()
    }
    return { version: SCHEDULE_VERSION, sources: doc.sources }
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode
    if (status !== 404) {
      // 读失败（库忙/权限）不能当成"没有状态"：那会让所有源被判定为"从没抓过"，
      // 于是一轮里把几百个源全抓一遍。抛出去让调用方跳过这一轮。
      throw err
    }
    return emptySchedule()
  }
}

/**
 * 合并式更新一个源的状态并写回。
 *
 * **必须走读改写**：同一个 owner 的多个源可能同时在抓（`FETCH_CONCURRENCY=4`），
 * 各自持有一份读到的旧 map，直接覆盖写会把别人的更新抹掉。所以：
 * 读最新一版 → 只合并本次要改的字段 → 写回，409 则重读重算（与 `entry-state` 同一套路）。
 *
 * 冲突时最多重试 `maxAttempts` 次；仍失败则放弃（只是这一轮的状态没记上，
 * 代价是下一轮多重抓一次，不影响正确性）。
 */
export async function mergeSourceSchedule(
  dbName: string,
  feedId: string,
  patch: SourceScheduleEntry,
  options: { maxAttempts?: number } = {},
): Promise<boolean> {
  const db = createCouchDb(dbName)
  const maxAttempts = options.maxAttempts ?? 5

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let current: (Partial<ScheduleState> & { _rev?: string }) | null = null
    try {
      current = await db.get(SCHEDULE_DOC_ID) as Partial<ScheduleState> & { _rev?: string }
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 404) return false
      current = null
    }
    const sources = (current?.version === SCHEDULE_VERSION && current.sources) ? { ...current.sources } : {}
    const previous = sources[feedId] ?? {}
    // 只合并传入的字段：undefined 表示"不动这个字段"，与订阅文档的更新语义一致
    const merged: SourceScheduleEntry = { ...previous }
    for (const [key, value] of Object.entries(patch) as Array<[keyof SourceScheduleEntry, unknown]>) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value
    }
    sources[feedId] = merged

    const body: Record<string, unknown> = { _id: SCHEDULE_DOC_ID, version: SCHEDULE_VERSION, sources }
    if (current?._rev) body._rev = current._rev
    try {
      await db.insert(body as never)
      return true
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 409) return false
      // 409：被别的抓取抢先写了，重读再来
    }
  }
  return false
}

/** 整份写回（重建/批量计算保留条数时用；同样是读改写语义） */
export async function writeSchedule(dbName: string, state: ScheduleState): Promise<boolean> {
  const db = createCouchDb(dbName)
  for (let attempt = 0; attempt < 5; attempt++) {
    let rev: string | undefined
    try {
      const current = await db.get(SCHEDULE_DOC_ID) as { _rev?: string }
      rev = current?._rev
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 404) return false
    }
    try {
      await db.insert({ _id: SCHEDULE_DOC_ID, version: SCHEDULE_VERSION, sources: state.sources, ...(rev ? { _rev: rev } : {}) } as never)
      return true
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode !== 409) return false
    }
  }
  return false
}

/** 退订时清掉该源的状态（否则它占着 map 且下次重新订阅会继承旧的 lastFetchedAt） */
export async function dropSourceSchedule(dbName: string, feedId: string): Promise<void> {
  const db = createCouchDb(dbName)
  try {
    const current = await db.get(SCHEDULE_DOC_ID) as Partial<ScheduleState> & { _rev?: string }
    if (!current?.sources || !(feedId in current.sources)) return
    const sources = { ...current.sources }
    delete sources[feedId]
    await db.insert({
      _id: SCHEDULE_DOC_ID,
      _rev: current._rev,
      version: SCHEDULE_VERSION,
      sources,
    } as never)
  } catch {
    // 文档不存在/写入冲突：退订清理的其余步骤会兜住（条目按前缀 purge 与状态无关）
  }
}
