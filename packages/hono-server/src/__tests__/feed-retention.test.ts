import { describe, expect, it } from "vitest"
import {
  computeActivityBytesPerDay,
  nextRetentionEntries,
  RETENTION_TIERS,
} from "../services/feed-retention-policy"

/**
 * 自适应保留条数的边界钉子。
 *
 * 这里测的是纯函数；I/O（读源库 info/视图、写 PG、裁剪）在 services/feed-retention.ts。
 * 重点钉住两件事：**分档阈值**与**滞回/一次一档**（N 变小会删历史，不能抖）。
 */

const KB = 1024
const MB = 1024 * 1024

/** 造一个"跨度 spanDays 天"的快照 */
function snapshot(externalBytes: number, spanDays: number, docCount = 30) {
  const newest = new Date("2026-10-20T00:00:00.000Z").getTime()
  const oldest = newest - spanDays * 86_400_000
  return {
    externalBytes,
    docCount,
    newestPublishedAt: new Date(newest).toISOString(),
    oldestPublishedAt: new Date(oldest).toISOString(),
  }
}

describe("computeActivityBytesPerDay", () => {
  it("按跨度折算日均字节", () => {
    expect(computeActivityBytesPerDay(snapshot(7 * MB, 7))).toBeCloseTo(MB, 6)
  })

  it("跨度超过 14 天时按 14 天算（只关心最近两周）", () => {
    expect(computeActivityBytesPerDay(snapshot(28 * MB, 28))).toBeCloseTo(2 * MB, 6)
  })

  it("跨度很短（同一批写入）时用 1 小时做下限，不除以接近 0 的数", () => {
    // 100KB 在 0 天跨度内 → 100KB / (1/24 天) ≈ 2.4MB/天
    expect(computeActivityBytesPerDay(snapshot(100 * KB, 0))).toBeCloseTo(100 * KB * 24, 3)
  })

  it("样本不足 / 日期无效 → null（不要拿噪声改 N）", () => {
    expect(computeActivityBytesPerDay(snapshot(MB, 7, 2))).toBeNull()
    expect(computeActivityBytesPerDay({
      externalBytes: MB,
      docCount: 30,
      newestPublishedAt: "not-a-date",
      oldestPublishedAt: "also-not",
    })).toBeNull()
  })

  it("没有日期（新库 / 视图缺失）→ null", () => {
    expect(computeActivityBytesPerDay({ externalBytes: MB, docCount: 30 })).toBeNull()
  })
})

describe("nextRetentionEntries", () => {
  it("首次计算（retention_entries 为 null）直接落到目标档", () => {
    expect(nextRetentionEntries(null, 3 * MB)).toBe(10)
    expect(nextRetentionEntries(null, 700 * KB)).toBe(20)
    expect(nextRetentionEntries(null, 200 * KB)).toBe(30)
    expect(nextRetentionEntries(null, 10 * KB)).toBe(50)
  })

  it("活跃度算不出来时保持原有 N", () => {
    expect(nextRetentionEntries(30, null)).toBe(30)
    expect(nextRetentionEntries(null, null)).toBe(50)
  })

  it("变档一次只挪一档（单日尖峰不能一次删掉几十条）", () => {
    expect(nextRetentionEntries(50, 3 * MB)).toBe(30)
    expect(nextRetentionEntries(30, 3 * MB)).toBe(20)
    expect(nextRetentionEntries(20, 3 * MB)).toBe(10)
    expect(nextRetentionEntries(10, 3 * MB)).toBe(10)
  })

  it("滞回：贴着档位边界来回抖时不动", () => {
    // 30 → 20 需要 ≥ 512KB × 1.2
    expect(nextRetentionEntries(30, 550 * KB)).toBe(30)
    expect(nextRetentionEntries(30, 700 * KB)).toBe(20)
    // 20 → 30 需要 ≤ 512KB × 0.8
    expect(nextRetentionEntries(20, 450 * KB)).toBe(20)
    expect(nextRetentionEntries(20, 400 * KB)).toBe(30)
  })

  it("活跃度下降时逐档放宽，最多回到 50", () => {
    expect(nextRetentionEntries(10, 0)).toBe(20)
    expect(nextRetentionEntries(20, 0)).toBe(30)
    expect(nextRetentionEntries(30, 0)).toBe(50)
    expect(nextRetentionEntries(50, 0)).toBe(50)
  })

  it("结果永远落在档位表里", () => {
    const allowed = new Set(RETENTION_TIERS.map((tier) => tier.entries))
    for (const current of [10, 20, 30, 50]) {
      for (const rate of [0, 100 * KB, 300 * KB, 600 * KB, MB, 5 * MB]) {
        expect(allowed.has(nextRetentionEntries(current, rate))).toBe(true)
      }
    }
  })
})
