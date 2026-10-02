import { describe, it, expect } from 'vitest'
import { isReaderRoute, READER_PANE_MIN_WIDTH } from '../../composables/useReaderLayout'

/**
 * 三栏（列表 + 常驻阅读栏）只在列表页成立。
 *
 * 路由判断是布局的第二把锁：页面卸载时不清共享状态（页面切换的挂载/卸载顺序不保证），
 * 靠「不在列表页就一律不算」兜底，所以这里的边界要钉住。
 */
describe('isReaderRoute', () => {
  it('四个列表页 + 收藏页命中', () => {
    for (const path of [
      '/timeline',
      '/saved',
      '/rss/feed/-EGH98Uu-bNGGYJj',
      '/rss/group/%E6%96%B0%E9%97%BB',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj/posts'
    ]) {
      expect(isReaderRoute(path), path).toBe(true)
    }
  })

  it('非列表页不命中（详情仍走弹窗）', () => {
    for (const path of [
      '/',
      '/profile',
      '/login',
      '/offline',
      '/bots/explore',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj',
      '/rss/feed',
      '/rss/feed/-EGH98Uu-bNGGYJj/extra',
      '/bots/6qtpuepzbtc4m8xdv3wpkntj/posts/extra'
    ]) {
      expect(isReaderRoute(path), path).toBe(false)
    }
  })

  it('断点就是侧边栏出现的 lg（1024）', () => {
    expect(READER_PANE_MIN_WIDTH).toBe(1024)
  })
})
