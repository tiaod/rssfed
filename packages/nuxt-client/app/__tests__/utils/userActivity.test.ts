import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  bindUserActivityTracking,
  isDocumentHidden,
  lastUserActivityAt,
  markUserActivity,
  resetUserActivity
} from '~/utils/userActivity'

/**
 * 「用户此刻是不是在跟界面打交道」的记录。
 *
 * 它只做一件事：把最后一次操作的时间如实记下来，安静多久算空闲由 decideIdleRun 判断
 *（见 utils/localCompact）。所以这里要盯的是记录本身准不准，以及事件绑定不会把 Event
 * 当成时间戳存进去 —— 那会让所有 `now - lastActivityAt` 变成 NaN，维护再也不会动手。
 */
describe('userActivity', () => {
  beforeEach(() => {
    resetUserActivity()
  })

  afterEach(() => {
    resetUserActivity()
  })

  it('从未记录过时为 0：调用方据此判断「一直没人用」', () => {
    expect(lastUserActivityAt()).toBe(0)
  })

  it('记下传入的时间', () => {
    markUserActivity(1234)
    expect(lastUserActivityAt()).toBe(1234)
  })

  it('不传时间就是此刻', () => {
    const before = Date.now()
    markUserActivity()
    expect(lastUserActivityAt()).toBeGreaterThanOrEqual(before)
  })

  it('后一次覆盖前一次（只关心最后一次）', () => {
    markUserActivity(1000)
    markUserActivity(2000)
    expect(lastUserActivityAt()).toBe(2000)
  })

  it('reset 之后回到「没记到过」', () => {
    markUserActivity(1000)
    resetUserActivity()
    expect(lastUserActivityAt()).toBe(0)
  })

  it('绑定后各种操作都会被记到，且记的是时间戳而不是 Event', () => {
    bindUserActivityTracking()
    const before = Date.now()
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      resetUserActivity()
      window.dispatchEvent(new Event(type))
      const at = lastUserActivityAt()
      // 直接把 markUserActivity 交给 addEventListener 会把 Event 存进来，
      // 之后 `now - lastActivityAt` 全是 NaN —— 这条断言就是那个坑的守门人
      expect(typeof at, type).toBe('number')
      expect(at, type).toBeGreaterThanOrEqual(before)
    }
  })

  it('重复绑定不会叠加监听：每个事件只绑一次', async () => {
    // 模块级的 bound 标志会跨用例残留，所以这里要拿一份全新的模块实例来观察首次绑定
    vi.resetModules()
    const addSpy = vi.spyOn(window, 'addEventListener')
    try {
      const fresh = await import('~/utils/userActivity')
      fresh.bindUserActivityTracking()
      fresh.bindUserActivityTracking()
      fresh.bindUserActivityTracking()
      const bound = addSpy.mock.calls.map(([name]) => name).sort()
      expect(bound).toEqual(['keydown', 'pointerdown', 'scroll', 'touchstart', 'wheel'])
    } finally {
      addSpy.mockRestore()
    }
  })

  it('监听是捕获 + passive：滚动不冒泡，且监听器不能拖慢滚动', async () => {
    vi.resetModules()
    const addSpy = vi.spyOn(window, 'addEventListener')
    try {
      const fresh = await import('~/utils/userActivity')
      fresh.bindUserActivityTracking()
      for (const [, , options] of addSpy.mock.calls) {
        expect(options).toMatchObject({ capture: true, passive: true })
      }
    } finally {
      addSpy.mockRestore()
    }
  })
})

describe('isDocumentHidden', () => {
  it('默认可见：happy-dom 里 visibilityState 是 visible', () => {
    expect(isDocumentHidden()).toBe(false)
  })

  it('页面切到后台时为真', () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      expect(isDocumentHidden()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
