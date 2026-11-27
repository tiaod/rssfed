import type { FetchRoundSummary } from "../services/timeline-events"

/**
 * 一轮抓取的记账：调度 tick 开一轮，这一轮入队的 job 把结果记进来，下一 tick 结算成一条流水。
 *
 * ## 为什么不在 job 里直接写流水
 *
 * 一个用户一轮可能几百个源到期。每源写一条会把「同步日志」刷爆（旧模型实测 4 小时 671 条、
 * 564 条是空转，有价值的事件全被淹了）。反过来，调度器在入队那一刻只知道「哪些源到期」，
 * 「新增多少条 / 裁剪多少 / 失败几个」要等 job 跑完才知道 —— 两边各写一半就是两条对不上的记录。
 *
 * 折中是**进程内记一层**：调度时开一轮（sources / due 当场能定），job 完成时累加其余三项，
 * 下一 tick 结算成一条「上一轮抓取干了什么」。
 *
 * ## 为什么按 owner 记、不记 Bot
 *
 * 流水表的 `user_id` 外键指向用户，Bot 没有对应的流水归属。Bot 抓取失败只进服务端日志 ——
 * 面板要回答的是「服务端在替我抓吗」，Bot 的产出问题在 Bot 页面看。
 *
 * ## 为什么带轮次令牌
 *
 * 一个 tick 入队的几百个 job 里，慢的那几个可能拖到下一轮还在跑（单源最长 10s + 错峰 90s，
 * 而 tick 间隔 15 分钟，正常够；但手动强刷或队列积压时会撞上）。job 只认自己那一轮的令牌，
 * 迟到的结果直接丢弃 —— 宁可少记一次，也不要把上一轮的数字算进这一轮。
 * 同理，手动同步（路由直接入队、没有令牌）不污染定时轮次的记账。
 *
 * ## 代价
 *
 * 进程重启会丢掉尚未结算的那一轮。可以接受：流水只是给人看的调试记录，
 * 真正的状态是 `_local/schedule`（每源抓取时刻与失败次数）与心跳（抓取还在不在跑）。
 */

/** 还没结算的一轮：调度时定下 sources / due，job 完成后累加其余三项 */
interface PendingFetchRound {
  /** 本轮令牌（job 携带它回来认领） */
  token: string
  /** 本轮检查的订阅源总数 */
  sources: number
  /** 本轮判出来到期的源数 */
  due: number
  /** 本轮开始的时刻（结算时算耗时） */
  startedAt: number
  /**
   * 最后一个回填结果的时刻。
   *
   * 不能用「结算时刻 - 开始时刻」当耗时：结算是下一个 tick 做的，那样算出来永远是整个
   * 调度间隔（15 分钟），日志里会写成「抓取耗时 900000ms」。这里取「到最后一个 job 回来为止」，
   * 才是这一轮真的花了多久。
   */
  lastActivityAt: number
  newEntries: number
  trimmedEntries: number
  failures: number
}

export interface SettledFetchRound {
  round: FetchRoundSummary
  ms: number
}

/** 一个 job 的结果累加项（只传自己知道的字段） */
export interface FetchOutcomePatch {
  newEntries?: number
  trimmedEntries?: number
  failures?: number
}

/**
 * 进程内的记账簿。
 *
 * 刻意做成有状态的工厂而不是模块级单例：单例在测试里会跨用例串味，
 * 而调度器只需要一份（见 `workers/index.ts`）。
 */
export function createFetchRoundBook() {
  const pending = new Map<string, PendingFetchRound>()
  let sequence = 0

  /**
   * 开一轮，返回这一轮的令牌。
   *
   * 同一 owner 已有未结算的一轮时直接覆盖：说明上一轮还有 job 没回来，
   * 而调度不能为了一条调试记录停下来等它。被覆盖那一轮的 job 之后会因令牌不符被丢弃。
   */
  function begin(key: string, input: { sources: number, due: number, now?: number }): string {
    const token = `${input.now ?? Date.now()}#${++sequence}`
    const startedAt = input.now ?? Date.now()
    pending.set(key, {
      token,
      sources: input.sources,
      due: input.due,
      startedAt,
      lastActivityAt: startedAt,
      newEntries: 0,
      trimmedEntries: 0,
      failures: 0,
    })
    return token
  }

  /** 记一个 job 的结果；令牌对不上（迟到的旧 job / 手动同步）就丢弃 */
  function note(key: string, token: string | undefined, patch: FetchOutcomePatch, now: number = Date.now()): void {
    if (!token) return
    const current = pending.get(key)
    if (!current || current.token !== token) return
    current.lastActivityAt = Math.max(current.lastActivityAt, now)
    current.newEntries += Math.max(0, patch.newEntries ?? 0)
    current.trimmedEntries += Math.max(0, patch.trimmedEntries ?? 0)
    current.failures += Math.max(0, patch.failures ?? 0)
  }

  /** 结算并清空：返回这一轮的结论与耗时；没有未结算的一轮时返回 null */
  function settle(key: string, now: number = Date.now()): SettledFetchRound | null {
    const current = pending.get(key)
    if (!current) return null
    pending.delete(key)
    return {
      round: {
        sources: current.sources,
        due: current.due,
        newEntries: current.newEntries,
        trimmedEntries: current.trimmedEntries,
        failures: current.failures,
      },
      // 耗时只算到最后一个 job 回来为止（见 lastActivityAt 的说明）
      ms: Math.max(0, Math.min(now, current.lastActivityAt) - current.startedAt),
    }
  }

  /** 该 owner 有没有未结算的一轮（排查用：进程内状态，不落库） */
  function has(key: string): boolean {
    return pending.has(key)
  }

  return { begin, note, settle, has }
}

export type FetchRoundBook = ReturnType<typeof createFetchRoundBook>

/** 记账簿的 key：用户与 Bot 的 id 各自独立命名空间，不靠 id 本身不撞车 */
export function roundKey(kind: "user" | "bot", id: string): string {
  return `${kind}:${id}`
}
