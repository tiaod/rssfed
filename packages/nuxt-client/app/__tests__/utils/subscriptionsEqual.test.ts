import { describe, it, expect } from 'vitest'
import { subscriptionsEqual } from '../../utils/subscriptionsEqual'
import type { SubscriptionItem } from '../../types/rss'

/**
 * 侧边栏「增量刷新」的判据：user-state 库同时承载订阅与已读/收藏，
 * 标记一次已读就会触发侧边栏重新加载，这里必须能把「与订阅无关的触发」短路掉，
 * 否则整棵导航菜单会白重渲染（几百项时是几十毫秒的纯浪费）。
 */

const feed = (over: Partial<SubscriptionItem> = {}): SubscriptionItem => ({
  id: 'feed-1',
  title: '源一',
  createdAt: '2025-01-01T00:00:00.000Z',
  ...over
})

describe('subscriptionsEqual', () => {
  it('初次加载（旧值为 null）视为变化', () => {
    expect(subscriptionsEqual(null, [feed()])).toBe(false)
    expect(subscriptionsEqual(null, [])).toBe(false)
  })

  it('内容与顺序完全一致时不视为变化', () => {
    const a = [feed(), feed({ id: 'feed-2', title: '源二' })]
    const b = [feed(), feed({ id: 'feed-2', title: '源二' })]
    expect(subscriptionsEqual(a, b)).toBe(true)
  })

  it('数量不同视为变化', () => {
    expect(subscriptionsEqual([feed()], [feed(), feed({ id: 'feed-2' })])).toBe(false)
  })

  it('顺序变化视为变化（侧边栏按顺序渲染）', () => {
    const a = [feed(), feed({ id: 'feed-2', title: '源二' })]
    const b = [feed({ id: 'feed-2', title: '源二' }), feed()]
    expect(subscriptionsEqual(a, b)).toBe(false)
  })

  it('改名 / 改分类 / feed↔bot 切换视为变化', () => {
    expect(subscriptionsEqual([feed()], [feed({ title: '改过的名字' })])).toBe(false)
    expect(subscriptionsEqual([feed()], [feed({ category: '技术' })])).toBe(false)
    expect(subscriptionsEqual([feed()], [feed({ kind: 'bot' })])).toBe(false)
  })

  it('与侧边栏无关的字段变化不视为变化', () => {
    const a = [feed({ siteUrl: 'https://a.example', description: '旧描述', image: 'https://a.example/i.png' })]
    const b = [feed({
      siteUrl: 'https://b.example',
      description: '新描述',
      image: 'https://b.example/i.png',
      createdAt: '2026-09-01T00:00:00.000Z'
    })]
    expect(subscriptionsEqual(a, b)).toBe(true)
  })
})
