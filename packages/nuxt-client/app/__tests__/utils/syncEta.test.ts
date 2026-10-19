import { describe, it, expect } from 'vitest'
import { computeRemainingMs, formatEta, ETA_MIN_DOCS, ETA_MIN_WINDOW_MS } from '../../utils/syncEta'

/**
 * 复制剩余时间估算。
 *
 * 只盯两件事：
 *   1. 样本不足 / 服务端没给 pending 时返回 null（UI 不显示），绝不拿 0 或猜的值充数；
 *   2. 速率口径是「本轮写入数 / 本轮耗时」，累计值必须减掉基准，否则第二轮 ETA 会被上一轮拖偏。
 */

const NOW = 1_700_000_000_000

/** 本轮已经跑满最小窗口、写满最小条数的基准 */
function baseAt(elapsed: number, written = 0) {
  return { written, at: NOW - elapsed }
}

describe('computeRemainingMs', () => {
  it('按本轮写入速率折算剩余条数', () => {
    // 10 秒写入 40 条 → 4 条/秒，剩 100 条 → 25 秒
    expect(computeRemainingMs({
      pending: 100,
      written: 50,
      base: baseAt(10_000, 10),
      now: NOW
    })).toBe(25_000)
  })

  it('累计写入数要减掉基准（第二轮复制从 60 涨到 64 只算 4 条）', () => {
    // 4 秒写入 4 条 → 1 条/秒，剩 20 条 → 20 秒
    expect(computeRemainingMs({
      pending: 20,
      written: 64,
      base: baseAt(4000, 60),
      now: NOW
    })).toBe(20_000)
  })

  it('服务端没给 pending 时算不出来：返回 null 而不是 0', () => {
    expect(computeRemainingMs({ written: 100, base: baseAt(10_000), now: NOW })).toBeNull()
  })

  it('pending 为 0 表示已经拉完：不再报 ETA', () => {
    expect(computeRemainingMs({ pending: 0, written: 100, base: baseAt(10_000), now: NOW })).toBeNull()
  })

  it('样本时长或条数不足时不给 ETA（宁可显示「正在拉取」）', () => {
    // 时间不够
    expect(computeRemainingMs({
      pending: 100,
      written: 100,
      base: baseAt(ETA_MIN_WINDOW_MS - 1),
      now: NOW
    })).toBeNull()
    // 条数不够
    expect(computeRemainingMs({
      pending: 100,
      written: ETA_MIN_DOCS - 1,
      base: baseAt(10_000),
      now: NOW
    })).toBeNull()
  })

  it('基准比当前累计值还大（上一轮的基准）时不可比，返回 null', () => {
    expect(computeRemainingMs({
      pending: 100,
      written: 10,
      base: baseAt(10_000, 50),
      now: NOW
    })).toBeNull()
  })

  it('非法输入不抛错', () => {
    expect(computeRemainingMs({ pending: Number.NaN, written: 10, base: baseAt(10_000), now: NOW })).toBeNull()
    expect(computeRemainingMs({ pending: 10, written: Number.NaN, base: baseAt(10_000), now: NOW })).toBeNull()
  })
})

describe('formatEta', () => {
  it('分档给出粗粒度文案，不报假精度', () => {
    expect(formatEta(3_000)).toBe('不到 10 秒')
    expect(formatEta(12_400)).toBe('20 秒')
    expect(formatEta(59_000)).toBe('1 分钟')
    expect(formatEta(62_000)).toBe('1 分钟')
    expect(formatEta(150_000)).toBe('3 分钟')
    expect(formatEta(3_600_000)).toBe('1 小时')
    expect(formatEta(3_900_000)).toBe('1 小时 5 分')
  })

  it('非法/非正数返回空串（调用方据此不拼这段文案）', () => {
    expect(formatEta(0)).toBe('')
    expect(formatEta(-1)).toBe('')
    expect(formatEta(Number.NaN)).toBe('')
  })
})
