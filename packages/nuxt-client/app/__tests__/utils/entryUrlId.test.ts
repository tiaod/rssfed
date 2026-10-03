import { describe, it, expect } from 'vitest'
import { toEntryDocId, toEntryUrlId } from '../../utils/entryUrlId'

const FEED = 'csMm3L6owKvUnbTF'
const HASH = '47aab7b9e338'
const DOC_ID = `entry:${FEED}:${HASH}`

/**
 * 地址段里的 id 与本地库文档 id 的换算。
 *
 * 这条换算必须可逆：地址里省掉了 `entry:<feedId>:` 前缀（源 id 已经写在地址路径里），
 * 取文档时要能原样拼回来 —— 拼错一个字符详情就打不开了。
 */
describe('toEntryUrlId / toEntryDocId', () => {
  it('文档 id → 地址段：去掉源前缀，只留 hash', () => {
    expect(toEntryUrlId(DOC_ID, FEED)).toBe(HASH)
  })

  it('地址段 → 文档 id：拼回源前缀（与上面互为逆运算）', () => {
    expect(toEntryDocId(HASH, FEED)).toBe(DOC_ID)
    expect(toEntryDocId(toEntryUrlId(DOC_ID, FEED), FEED)).toBe(DOC_ID)
    expect(toEntryUrlId(toEntryDocId(HASH, FEED), FEED)).toBe(HASH)
  })

  it('非本源的 id 原样保留：宁可地址难看，也不能截错 id', () => {
    const botEntry = 'entry:bot:6qtpuepzbtc4m8xdv3wpkntj:abcdef012345'
    expect(toEntryUrlId(botEntry, FEED)).toBe(botEntry)
    expect(toEntryUrlId('some-other-id', FEED)).toBe('some-other-id')
  })

  it('段里已经带 `:` 时按完整文档 id 处理：旧地址仍然打得开，也不会拼出 entry:<feedId>:entry:…', () => {
    expect(toEntryDocId(DOC_ID, FEED)).toBe(DOC_ID)
    expect(toEntryDocId('entry:bot:6qtpuepzbtc4m8xdv3wpkntj:abcdef012345', FEED))
      .toBe('entry:bot:6qtpuepzbtc4m8xdv3wpkntj:abcdef012345')
  })
})
