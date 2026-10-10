import { describe, expect, it } from 'vitest'
import { feedDocId } from '~/utils/feedDocId'

/**
 * 前端读 FeedDoc 时用的 id 规则，必须与后端
 * `packages/hono-server/src/couchdb/doc-ids.ts` 完全一致（否则下划线源在本地库里查不到元信息）。
 */
describe('feedDocId', () => {
  it('下划线开头的 feedId 加 feed 前缀', () => {
    expect(feedDocId('_2lv5T_YCYekFKFn')).toBe('feed_2lv5T_YCYekFKFn')
  })

  it('普通 feedId 原样返回', () => {
    expect(feedDocId('bggSCJ7OCiDyRiZ5')).toBe('bggSCJ7OCiDyRiZ5')
  })

  it('结果永远不以 _ 开头', () => {
    for (const id of ['_x', '_2lv5T_YCYekFKFn', 'normalId12345678']) {
      expect(feedDocId(id).startsWith('_')).toBe(false)
    }
  })
})
