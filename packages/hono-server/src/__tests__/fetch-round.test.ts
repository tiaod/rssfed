import { beforeEach, describe, expect, it } from "vitest"
import { createFetchRoundBook, roundKey } from "../workers/fetch-round"

/**
 * 一轮抓取的记账（设置页「同步日志」的数据来源）。
 *
 * 这里钉的是三条容易写错的性质：
 *   - 调度开一轮、job 回填、下一次结算 —— 数字要真的加到一起；
 *   - **令牌对不上的结果必须丢弃**：上一轮迟到的 job 算进这一轮，会让日志里的数字对不上，
 *     而这种错只在队列积压时出现，没有测试根本发现不了；
 *   - 结算后清空：同一轮不会被记两遍。
 */

let book: ReturnType<typeof createFetchRoundBook>
const KEY = roundKey("user", "u1")

beforeEach(() => {
  book = createFetchRoundBook()
})

describe("createFetchRoundBook", () => {
  it("调度开一轮、job 累加、结算得到合计与耗时", () => {
    const token = book.begin(KEY, { sources: 129, due: 3, now: 1_000 })
    book.note(KEY, token, { newEntries: 5, trimmedEntries: 2 })
    book.note(KEY, token, { newEntries: 1, failures: 1 })

    const settled = book.settle(KEY, 1_250)
    expect(settled).toEqual({
      round: { sources: 129, due: 3, newEntries: 6, trimmedEntries: 2, failures: 1 },
      ms: 250
    })
  })

  it("结算后就清空：同一轮不会被记两遍", () => {
    book.begin(KEY, { sources: 10, due: 1 })
    book.settle(KEY)
    expect(book.settle(KEY)).toBeNull()
    expect(book.has(KEY)).toBe(false)
  })

  it("令牌对不上（上一轮迟到的 job）直接丢弃", () => {
    book.begin(KEY, { sources: 10, due: 2 })
    book.note(KEY, "旧令牌", { newEntries: 99 })

    const settled = book.settle(KEY)
    expect(settled!.round.newEntries).toBe(0)
  })

  it("不带令牌（手动同步触发的 job）不进定时轮次的账", () => {
    book.begin(KEY, { sources: 10, due: 2 })
    book.note(KEY, undefined, { newEntries: 7 })
    expect(book.settle(KEY)!.round.newEntries).toBe(0)
  })

  it("新 tick 覆盖未结算的一轮：上一轮的数字不会被算进新的一轮", () => {
    const oldToken = book.begin(KEY, { sources: 10, due: 2 })
    book.note(KEY, oldToken, { newEntries: 4 })
    const newToken = book.begin(KEY, { sources: 10, due: 0 })
    book.note(KEY, oldToken, { newEntries: 4 })
    book.note(KEY, newToken, { newEntries: 1 })

    expect(book.settle(KEY)!.round).toMatchObject({ due: 0, newEntries: 1 })
  })

  it("空转轮次也能结算（due=0 是一轮，不是「没有跑」）", () => {
    book.begin(KEY, { sources: 42, due: 0 })
    expect(book.settle(KEY)!.round).toEqual({
      sources: 42, due: 0, newEntries: 0, trimmedEntries: 0, failures: 0
    })
  })

  it("负数被夹到 0（防御：worker 不该传负数，传了也不该把合计做小）", () => {
    const token = book.begin(KEY, { sources: 10, due: 1 })
    book.note(KEY, token, { newEntries: -5 })
    expect(book.settle(KEY)!.round.newEntries).toBe(0)
  })

  it("耗时只算到最后一个 job 回来为止，不算整个调度间隔", () => {
    // 结算发生在下一个 tick（15 分钟后）：若按「结算时刻 - 开始时刻」算，
    // 日志里会写成「抓取耗时 900000ms」，看起来像一轮跑了 15 分钟
    const token = book.begin(KEY, { sources: 10, due: 2, now: 1_000 })
    book.note(KEY, token, { newEntries: 1 }, 3_000)
    book.note(KEY, token, { newEntries: 1 }, 4_500)

    expect(book.settle(KEY, 900_000)!.ms).toBe(3_500)
  })

  it("空转轮次耗时是 0（没有 job 跑过，不该报成一轮的长度）", () => {
    book.begin(KEY, { sources: 10, due: 0, now: 1_000 })
    expect(book.settle(KEY, 900_000)!.ms).toBe(0)
  })

  it("用户与 Bot 的 key 不互相干扰", () => {
    const userKey = roundKey("user", "same-id")
    const botKey = roundKey("bot", "same-id")
    expect(userKey).not.toBe(botKey)

    book.begin(userKey, { sources: 1, due: 1 })
    book.begin(botKey, { sources: 2, due: 2 })
    expect(book.settle(userKey)!.round.sources).toBe(1)
    expect(book.settle(botKey)!.round.sources).toBe(2)
  })
})
