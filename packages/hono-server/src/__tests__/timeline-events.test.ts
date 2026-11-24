import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 聚合流水的写入策略。
 *
 * 这里钉的是**"什么该进流水、什么不该"**这个决定 —— 第一版每条轮次都记，4 小时 671 条、
 * 564 条是空转，把有价值的事件全淹了。所以重点覆盖三条分支：
 *   - 空转只更新心跳，不写流水；
 *   - 干了活的轮次写流水（窗口外新起一条）；
 *   - 窗口内的连续轮次并进上一条（一轮扫一遍抓取循环会连续触发好几次）。
 */

const mocks = vi.hoisted(() => ({
  /** db.insert(...).values(...) 的记录 */
  inserts: [] as Array<{ table: string, values: Record<string, unknown> }>,
  /** db.update(...).set(...) 的记录（合并上一条） */
  updates: [] as Array<Record<string, unknown>>,
  /** 上一条 reconcile 流水（null = 没有） */
  previousReconcile: null as null | { id: number, at: Date, data: unknown },
  /** 心跳行（readReconcileHeartbeat 用） */
  heartbeatRow: null as null | { at: Date, quietRounds: number },
  /** 裁剪 SQL 是否执行过 */
  pruned: 0,
}))

vi.mock("../db", () => {
  const table = (name: string) => ({ __name: name })
  const rowsFor = (name?: string) => {
    if (name === "timelineEvents") return mocks.previousReconcile ? [mocks.previousReconcile] : []
    if (name === "timelineReconcileHeartbeat") return mocks.heartbeatRow ? [mocks.heartbeatRow] : []
    return []
  }
  // select 的链式替身：from/where/orderBy 原样返回自己，limit 出结果；整条链可被 await
  const chain = (name?: string) => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      orderBy: () => self,
      limit: async () => rowsFor(name),
      then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsFor(name)),
    }
    return self
  }
  return {
    db: {
      insert: (t: { __name?: string }) => ({
        values: (values: Record<string, unknown>) => {
          const pending = {
            onConflictDoUpdate: async () => {
              mocks.inserts.push({ table: t.__name ?? "", values })
            },
            then: (resolve: (v: unknown) => unknown) => {
              mocks.inserts.push({ table: t.__name ?? "", values })
              return resolve(undefined)
            },
          }
          return pending
        },
      }),
      select: () => ({ from: (t: { __name?: string }) => chain(t.__name) }),
      selectDistinct: () => ({ from: (t: { __name?: string }) => chain(t.__name) }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            mocks.updates.push(values)
          },
        }),
      }),
      execute: async () => {
        mocks.pruned++
        return { rows: [] }
      },
      delete: () => ({ where: async () => [] }),
    },
    // 服务层还会 import 这些表（只用到表对象本身）
    timelineEvents: table("timelineEvents"),
    timelineReconcileHeartbeat: table("timelineReconcileHeartbeat"),
  }
})

const {
  describeRound,
  isRoundMeaningful,
  readReconcileHeartbeat,
  recordFetchRound,
  RECONCILE_MERGE_WINDOW_MS,
} = await import("../services/timeline-events")

type FetchRoundSummary = import("../services/timeline-events").FetchRoundSummary

const round = (over: Partial<FetchRoundSummary> = {}): FetchRoundSummary => ({
  sources: 129,
  due: 0,
  newEntries: 0,
  trimmedEntries: 0,
  failures: 0,
  ...over,
})

beforeEach(() => {
  mocks.inserts = []
  mocks.updates = []
  mocks.previousReconcile = null
  mocks.heartbeatRow = null
  mocks.pruned = 0
})

describe("isRoundMeaningful", () => {
  it("空转不算干了活", () => {
    expect(isRoundMeaningful(round())).toBe(false)
  })

  it("有到期源 / 有新增 / 有裁剪 / 有失败，任一非零都算干了活", () => {
    expect(isRoundMeaningful(round({ due: 1 }))).toBe(true)
    expect(isRoundMeaningful(round({ newEntries: 2 }))).toBe(true)
    expect(isRoundMeaningful(round({ trimmedEntries: 3 }))).toBe(true)
    expect(isRoundMeaningful(round({ failures: 1 }))).toBe(true)
  })
})

describe("describeRound", () => {
  it("干了活时把动作列出来，带上源数与耗时", () => {
    expect(describeRound(round({ due: 3 }), 28)).toBe("抓取：订阅 129 个源，3 个源到期（28ms）")
    expect(describeRound(round({ due: 1, newEntries: 40, trimmedEntries: 5 }), 31))
      .toBe("抓取：订阅 129 个源，1 个源到期；新增 40 条；裁剪 5 条（31ms）")
    expect(describeRound(round({ newEntries: 2, failures: 1 }), 9))
      .toBe("抓取：订阅 129 个源，新增 2 条；1 个源失败（9ms）")
  })

  it("空转也有描述（首次记录用），但措辞里没有动作", () => {
    expect(describeRound(round(), 15)).toBe("抓取：订阅 129 个源，无需抓取（15ms）")
  })
})

describe("recordFetchRound", () => {
  it("空转：心跳 quietRounds=1，同时仍写一条流水（方便排查）", async () => {
    await recordFetchRound({ userId: "u1", round: round(), ms: 15 })
    expect(mocks.inserts.map(i => i.table)).toEqual(["timelineReconcileHeartbeat", "timelineEvents"])
    expect(mocks.inserts[0]!.values).toMatchObject({ userId: "u1", quietRounds: 1 })
    expect(mocks.inserts[1]!.values).toMatchObject({
      kind: "reconcile",
      level: "info",
      message: "抓取：订阅 129 个源，无需抓取（15ms）",
    })
  })

  it("干了活、且没有上一条：新起一条流水（并保留心跳）", async () => {
    await recordFetchRound({ userId: "u1", round: round({ due: 2 }), ms: 30 })
    expect(mocks.inserts.map(i => i.table)).toEqual(["timelineReconcileHeartbeat", "timelineEvents"])
    expect(mocks.inserts[1]!.values).toMatchObject({
      userId: "u1",
      kind: "reconcile",
      message: "抓取：订阅 129 个源，2 个源到期（30ms）",
    })
    expect(mocks.pruned).toBe(1)
  })

  it("上一条在合并窗口内：并进它（累计轮数/脏源），不新增行", async () => {
    mocks.previousReconcile = {
      id: 7,
      at: new Date(Date.now() - 60_000),
      data: { sources: 129, due: 3, rounds: 2, newEntries: 0, trimmedEntries: 0, failures: 0 },
    }
    await recordFetchRound({ userId: "u1", round: round({ due: 1 }), ms: 22 })
    // 只写心跳，不写新流水
    expect(mocks.inserts.map(i => i.table)).toEqual(["timelineReconcileHeartbeat"])
    expect(mocks.updates).toHaveLength(1)
    expect(mocks.updates[0]).toMatchObject({
      message: "抓取：订阅 129 个源，连续 3 轮，共 4 个源到期",
      data: { rounds: 3, due: 4 },
    })
  })

  it("窗口内的连续空转：合并成「连续 N 轮无需搬运」", async () => {
    mocks.previousReconcile = {
      id: 9,
      at: new Date(Date.now() - 30_000),
      data: { sources: 129, due: 0, rounds: 4, newEntries: 0, trimmedEntries: 0, failures: 0 },
    }
    await recordFetchRound({ userId: "u1", round: round(), ms: 18 })
    expect(mocks.inserts.map(i => i.table)).toEqual(["timelineReconcileHeartbeat"])
    expect(mocks.updates[0]).toMatchObject({
      message: "抓取：订阅 129 个源，连续 5 轮无需抓取",
      data: { rounds: 5, due: 0 },
    })
  })

  it("上一条超出合并窗口：另起一条", async () => {
    mocks.previousReconcile = {
      id: 7,
      at: new Date(Date.now() - RECONCILE_MERGE_WINDOW_MS - 1_000),
      data: { sources: 129, due: 3, rounds: 2 },
    }
    await recordFetchRound({ userId: "u1", round: round({ due: 1 }), ms: 22 })
    expect(mocks.updates).toHaveLength(0)
    expect(mocks.inserts.map(i => i.table)).toEqual(["timelineReconcileHeartbeat", "timelineEvents"])
  })

  it("失败轮次标成 warn", async () => {
    await recordFetchRound({ userId: "u1", round: round({ failures: 2 }), ms: 22 })
    expect(mocks.inserts[1]!.values).toMatchObject({ kind: "reconcile", level: "warn" })
  })
})

describe("readReconcileHeartbeat", () => {
  it("没有过任何一轮抓取时返回 null", async () => {
    expect(await readReconcileHeartbeat("u1")).toBeNull()
  })

  it("有行时返回时刻与连续空转轮数", async () => {
    const at = new Date("2026-10-17T10:31:00.000Z")
    mocks.heartbeatRow = { at, quietRounds: 42 }
    expect(await readReconcileHeartbeat("u1")).toEqual({ at, quietRounds: 42 })
  })
})
