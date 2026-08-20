import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import PouchDB from 'pouchdb'
import { LOCAL_VIEWS, TIMELINE_VIEW, BY_FEED_VIEW } from '../utils/localViews'

/**
 * 本地条目 map view 的行为保障测试（Node 环境，leveldb 适配器）：
 * 视图是集中库查询的唯一通道，任何一次重构都必须保住下面这几条不变量——
 * 否则又会退回「find 一次拉 1 万条再 JS 排序」的老路（PouchDB 9 的 desc 排序
 * 对自建 Mango 索引不可用，view 才能拿到 descending）。
 */

const TMP_DB = '/tmp/rssfed-localviews-test'
let db: PouchDB.Database

interface Seeded { ms: number; id: string; feedId: string }

// 固定并列规则，模拟旧实现的时间戳排序（并集/分桶 oracle 都走同一规则）
function oracle(rows: { id: string; feedId: string; ms: number }[]): string[] {
  return rows
    .slice()
    .sort((a, b) => b.ms - a.ms || a.id.localeCompare(b.id))
    .map(r => r.id)
}

const seeded: Seeded[] = []

async function rowsOf(view: string, opts: any): Promise<string[]> {
  const res: any = await (db as any).query(view, opts)
  return res.rows.map((r: any) => r.key[r.key.length - 1]) // 最后一个 key 段恒为 _id
}

beforeAll(async () => {
  await new PouchDB(TMP_DB).destroy().catch(() => {})
  db = new PouchDB(TMP_DB)

  await db.put(LOCAL_VIEWS)

  // 造数据：故意留两篇发布时间完全相同（毫秒并列）验证边界不重不漏；
  // 多 feed 交错，另有一篇 type!=entry 与一篇无 publishedAt 的不该进视图。
  const T0 = Date.parse('2026-07-01T00:00:00Z')
  const docsSeen: { _id: string; feedId: string; ms: number }[] = []
  let idx = 0
  for (const feedId of ['f1', 'f2', 'f3', 'f4']) {
    for (let k = 0; k < 12; k++) {
      const ms = T0 - idx * 91111 // 刻意用不同间距制造穿插排序
      docsSeen.push({ _id: `${feedId}:${k}`, feedId, ms })
      idx++
    }
  }
  // 孤立的 repeat：同一 feed 相同 ms 双胞胎
  docsSeen.push({ _id: 'tw:a', feedId: 'f2', ms: T0 - 5 })
  docsSeen.push({ _id: 'tw:b', feedId: 'f2', ms: T0 - 5 })

  for (const d of docsSeen) {
    seeded.push({ ms: d.ms, id: d._id, feedId: d.feedId })
  }

  await db.bulkDocs(
    seeded.map(s => ({
      _id: s.id,
      type: 'entry',
      feedId: s.feedId,
      title: `约 ${s.id}`,
      url: `https://x/${s.id}`,
      publishedAt: new Date(s.ms).toISOString(),
      content: '<div>很长的正文字段，绝不能出现在视图 value 里</div><div style="width:100%;word-break:break-all;">x'.repeat(20),
      images: [],
    }))
  )
  await db.bulkDocs([
    { _id: 'bad-type', type: 'feed', publishedAt: new Date(T0).toISOString() },
    { _id: 'bad-ts', type: 'entry', publishedAt: 'not-a-date' },
  ])
})

afterAll(async () => {
  await db?.destroy().catch(() => {})
})

describe('timeline 视图（全局 desc）', () => {
  it('与「时间戳 desc + _id 决顺序」的 oracle 取前 L 条集合一致，且 ms 单调不增', async () => {
    const L = 7
    const got = await rowsOf(TIMELINE_VIEW, { descending: true, include_docs: false, limit: L })
    const want = oracle(seeded).slice(0, L)
    expect([...got].sort()).toEqual([...want].sort())

    const res = await db.query(TIMELINE_VIEW, { descending: true, limit: 1000, include_docs: false })
    const msList = res.rows.map(r => (r.key as [number, string])[0]!)
    expect(msList).toEqual([...msList].sort((a, b) => b - a))
  })

  it('value 只投影列表字段，绝不含 content 正文', async () => {
    const res = await db.query(TIMELINE_VIEW, { descending: true, limit: 10, include_docs: false })
    for (const row of res.rows) {
      expect(row.value).not.toHaveProperty('content')
      expect(Object.keys(row.value)).toContain('images')
    }
  })

  it('整库游标遍历不重不漏，且坏类型/坏时间的文档不在视图内', async () => {
    const walked: string[] = []
    let startkey: any
    for (;;) {
      const res = await db.query(TIMELINE_VIEW, {
        descending: true,
        include_docs: false,
        limit: 7,
        ...(startkey !== undefined ? { startkey, skip: 1 } : {}),
      })
      if (!res.rows.length) break
      walked.push(...res.rows.map(r => (r.key as [number, string])[1]!))
      startkey = res.rows[res.rows.length - 1]!.key
    }
    expect(new Set(walked).size).toBe(walked.length) // 不重不漏
    // 期望集合 = 恰好是所有合法 entry（seed 全部）——不含 bad-type / bad-ts
    const wantIds = seeded.map(s => s.id)
    expect([...walked].sort()).toEqual([...wantIds].sort())
  })
})

describe('by_feed 视图 + 归并（单源/分组）', () => {
  it('单源取前 L 与其自身 oracle 一致', async () => {
    const feedDoc = seeded.filter(s => s.feedId === 'f2').map(s => ({ id: s.id, feedId: s.feedId, ms: s.ms }))
    const L = 5
    const got = await rowsOf(BY_FEED_VIEW, { descending: true, startkey: ['f2', Number.MAX_SAFE_INTEGER, ''], limit: L })
    expect([...got].sort()).toEqual(oracle(feedDoc).slice(0, L).sort())
  })

  it('分组：各源浅取一页再归并，结果等于「参与源并集」的全局 top-L', async () => {
    const feeds = ['f1', 'f3']
    const L = 11
    const union = seeded.filter(s => feeds.includes(s.feedId)).map(s => ({ id: s.id, feedId: s.feedId, ms: s.ms }))
    const want = oracle(union).slice(0, L)

    // 复刻模块内归并：每源取 top-L，逐位挑最新的那条
    const perFeed = await Promise.all(
      feeds.map(f =>
        rowsOf(BY_FEED_VIEW, { descending: true, startkey: [f, Number.MAX_SAFE_INTEGER, ''], limit: L })
      )
    )
    const msOf = (id: string) => seeded.find(s => s.id === id)!.ms
    const ptr = perFeed.map(() => 0)
    const merged: string[] = []
    while (merged.length < L) {
      let best = -1
      let bestMs = -Infinity
      for (let i = 0; i < perFeed.length; i++) {
        const at = ptr[i]!
        const e = perFeed[i]![at]
        if (!e) continue
        if (msOf(e) > bestMs) {
          best = i
          bestMs = msOf(e)
        }
      }
      if (best === -1) break
      const id = perFeed[best]![ptr[best]!]!
      merged.push(id)
      ptr[best]!++
    }
    expect([...merged].sort()).toEqual([...want].sort())
  })
})
