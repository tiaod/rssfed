import { describe, it, expect } from 'vitest'
import { computeReplicateProgress } from '../../composables/usePouchDb'

/**
 * 由 PouchDB 复制的 change 事件推算「单个源拉到了几成」。
 *
 * 这个函数替代了「用 last_seq 相减算百分比」的做法：CouchDB 3.x 的 seq 是
 * `"1234-abc..."` 形态的字符串（切片后做算术没有意义），且它是远端库的全局序列号，
 * 与本次复制起点之差并不等于「已拉取占总量的比例」。
 *
 * 真正可用的信号是事件对象上的两个数字：
 *   - docs_written：本次复制累计写入的文档数；
 *   - pending：服务端 `_changes` 返回的剩余变更数（CouchDB 2.0+ 才有，
 *     且 PouchDB 只在「本批有文档写入」时把它挂上来）。
 */
describe('computeReplicateProgress', () => {
  it('首次事件：已写入 / (已写入 + 剩余) 折算百分比', () => {
    // 第一批 20 条写完，服务端说还剩 80 条 → 20%
    expect(computeReplicateProgress({ docs_written: 20, pending: 80 })).toBe(20)
  })

  it('pending 为 0 表示服务端已无剩余变更，直接给满', () => {
    // 最后一批：pending 明确为 0，此时无论已写入多少都算拉完
    expect(computeReplicateProgress({ docs_written: 100, pending: 0 })).toBe(100)
    expect(computeReplicateProgress({ docs_written: 1, pending: 0 })).toBe(100)
  })

  it('pending 缺失时沿用上次进度，绝不谎报 100%', () => {
    // PouchDB 在没有文档写入的批次上不会附 pending。若把它当 0，
    // 进度条会在第一批之后就跳到 100%，而复制其实还在继续
    expect(computeReplicateProgress({ docs_written: 20 }, 20)).toBe(20)
    expect(computeReplicateProgress({}, 0)).toBe(0)
  })

  it('进度严格单调：批间 pending 小幅回弹时不允许倒退', () => {
    const first = computeReplicateProgress({ docs_written: 40, pending: 60 }, 0)
    expect(first).toBe(40)
    // 下一批服务端报出的 pending 变多（期间远端又有新写入）：进度保持不回退
    const second = computeReplicateProgress({ docs_written: 60, pending: 140 }, first)
    expect(second).toBe(40)
    // 真正的推进仍然生效
    expect(computeReplicateProgress({ docs_written: 120, pending: 30 }, second)).toBe(80)
  })

  it('结果始终落在 0-100 内', () => {
    expect(computeReplicateProgress({ docs_written: 0, pending: 50 })).toBe(0)
    expect(computeReplicateProgress({ docs_written: 999, pending: 1 })).toBe(100)
    expect(computeReplicateProgress({ docs_written: 999, pending: 1 }, 100)).toBe(100)
  })
})
