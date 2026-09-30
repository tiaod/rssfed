import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncProgressBar from '../../components/SyncProgressBar.vue'

/**
 * 顶部同步进度条的展示口径。
 *
 * 关键行为：进度按「源内进度」加权（见 utils/syncStatusSummary）。
 * 老口径是 done/total：一个几千条的源在拉到一半时，进度条纹丝不动，
 * 而这段时间恰恰是用户盯着进度条看的全部时间。
 */

const H = vi.hoisted(() => ({
  statuses: null as Record<string, Record<string, unknown>> | null,
  paused: null as { value: boolean } | null,
  storageBroken: null as { value: string | null } | null
}))

vi.mock('~/composables/usePouchDb', async () => {
  const { reactive: r, ref: rf } = await import('vue')
  return {
    usePouchDb: () => ({
      syncStatuses: (H.statuses ??= r({})),
      paused: (H.paused ??= rf(false) as unknown as { value: boolean }),
      storageBroken: (H.storageBroken ??= rf(null) as unknown as { value: string | null })
    })
  }
})

const STUBS = {
  UProgress: {
    name: 'UProgress',
    props: ['modelValue', 'size', 'color'],
    template: '<div class="progress" :data-value="modelValue" :data-color="color" />'
  }
}

/** 组件模板用了 Nuxt UI 的 UProgress：其余按原样渲染（含文案 span） */
function mountBar() {
  return mount(SyncProgressBar, { global: { stubs: STUBS } })
}

beforeEach(() => {
  H.statuses = null
  H.paused = null
  H.storageBroken = null
})

describe('SyncProgressBar（顶部进度条）', () => {
  it('没有同步活动时不渲染', () => {
    const wrapper = mountBar()
    expect(wrapper.find('.progress').exists()).toBe(false)
  })

  it('进行中的源按源内进度加权：拉到一半时进度条走到一半', () => {
    H.statuses = { a: { feedId: 'a', status: 'syncing', version: 0, progress: 50 } }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-value')).toBe('50')
    expect(wrapper.text()).toContain('正在同步 1 个')
    expect(wrapper.text()).toContain('剩余 1 个')
    expect(wrapper.text()).toContain('50%')
  })

  it('没有 progress 的源按 0 计：完成的库满格、进行中的库不虚报', () => {
    H.statuses = {
      a: { feedId: 'a', status: 'idle', version: 1 },
      b: { feedId: 'b', status: 'syncing', version: 0 }
    }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-value')).toBe('50')
  })

  it('本地存储故障：进度条常驻并转为 error 色，显示可操作的原因', () => {
    H.storageBroken = { value: '本地缓存写入失败（存储空间不足或数据库已损坏）' }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-color')).toBe('error')
    expect(wrapper.text()).toContain('本地缓存写入失败')
  })
})
