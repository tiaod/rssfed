import { describe, it, expect } from 'vitest'
import { diffEntryHeads, withStableHead } from '../../utils/entrySync'

describe('diffEntryHeads', () => {
  it('头部插入新条目：判定为打断阅读', () => {
    const diff = diffEntryHeads(['a', 'b', 'c'], ['x', 'a', 'b', 'c'])
    expect(diff.insertedAtHead).toBe(true)
    expect(diff.addedCount).toBe(1)
  })

  it('定长窗口下头部插入挤掉最旧条目：仍判定为打断阅读', () => {
    // 这是真实场景：窗口固定为最新 N 条，插入必然伴随挤出
    const diff = diffEntryHeads(['a', 'b', 'c'], ['x', 'a', 'b'])
    expect(diff.insertedAtHead).toBe(true)
    expect(diff.addedCount).toBe(1)
  })

  it('旧文补录插到列表中间：同样判定为打断阅读', () => {
    const diff = diffEntryHeads(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])
    expect(diff.insertedAtHead).toBe(true)
    expect(diff.addedCount).toBe(1)
  })

  it('新增都排在当前列表之后：静默上屏', () => {
    const diff = diffEntryHeads(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'])
    expect(diff.insertedAtHead).toBe(false)
    expect(diff.addedCount).toBe(2)
  })

  it('窗口内旧条目被替换：按插入处理（保守，用户视野里的内容变了）', () => {
    const diff = diffEntryHeads(['a', 'b', 'c'], ['a', 'b', 'x'])
    expect(diff.insertedAtHead).toBe(true)
    expect(diff.addedCount).toBe(1)
  })

  it('条目被删除（无新增）不判为头部插入', () => {
    const diff = diffEntryHeads(['a', 'b', 'c'], ['b', 'c'])
    expect(diff.insertedAtHead).toBe(false)
    expect(diff.addedCount).toBe(0)
  })

  it('首屏（当前列表为空）不判为头部插入', () => {
    const diff = diffEntryHeads([], ['a', 'b'])
    expect(diff.insertedAtHead).toBe(false)
    expect(diff.addedCount).toBe(2)
  })

  it('内容更新（id 序列不变）不需要提示', () => {
    const diff = diffEntryHeads(['a', 'b'], ['a', 'b'])
    expect(diff.insertedAtHead).toBe(false)
    expect(diff.addedCount).toBe(0)
  })
})

describe('withStableHead', () => {
  const list = (ids: string[]) => ids.map(id => ({ id }))
  const idsOf = (rows: { id: string }[]) => rows.map(e => e.id)

  it('过滤掉排在当前列表之前的头部新增，保留尾部扩展', () => {
    const current = list(['b', 'a'])
    const next = list(['c', 'b', 'a', 'z'])
    expect(idsOf(withStableHead(current, next))).toEqual(['b', 'a', 'z'])
  })

  it('中间插入的条目一并过滤（不推动下方内容）', () => {
    const current = list(['a', 'b', 'c'])
    const next = list(['a', 'x', 'b', 'c', 'd'])
    expect(idsOf(withStableHead(current, next))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('首屏（当前列表为空）整窗照收', () => {
    expect(idsOf(withStableHead([], list(['a', 'b'])))).toEqual(['a', 'b'])
  })

  it('定长窗口下被挤出窗口的当前条目补回末尾，列表不缩短', () => {
    // 头部来了 x，窗口只装得下 3 条 → c 被挤出；c 仍应留在列表里
    const current = list(['a', 'b', 'c'])
    const next = list(['x', 'a', 'b'])
    expect(idsOf(withStableHead(current, next))).toEqual(['a', 'b', 'c'])
  })

  it('当前列表条目被删时仍保留（避免列表凭空消失，删除属远端行为）', () => {
    const current = list(['a', 'b', 'c'])
    const next = list(['a', 'c'])
    expect(idsOf(withStableHead(current, next))).toEqual(['a', 'c', 'b'])
  })
})
