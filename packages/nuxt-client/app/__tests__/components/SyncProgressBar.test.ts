import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncProgressBar from '../../components/SyncProgressBar.vue'

/**
 * 顶部同步进度条的展示口径。
 *
 * 关键行为：进度按「库内进度」加权（见 utils/syncStatusSummary）。
 * 老口径是 done/total：一个几千条的时间线库在拉到一半时，进度条纹丝不动，
 * 而这段时间恰恰是用户盯着进度条看的全部时间。
 *
 * 文案只报百分比、不报「N 个」：聚合改造后同步目标是固定的两个库（时间线 + 用户状态），
 * 说「正在同步 1 个」既没信息量又容易被读成「1 个订阅源」。
 *
 * 同步中额外带上「云端多大 / 本站缓存多少 / 预计还需多久」：体积给的是量级
 * （云端用 CouchDB 的 external，本站是整站缓存），剩余时间来自复制的 pending 速率。
 */

const H = vi.hoisted(() => ({
  statuses: null as Record<string, Record<string, unknown>> | null,
  paused: null as { value: boolean } | null,
  storageBroken: null as { value: string | null } | null,
  cloudInfo: null as { value: unknown } | null,
  cloudRefresh: vi.fn(),
  storageInfo: null as { value: unknown } | null,
  storageSupported: null as { value: boolean } | null,
  storageRefresh: vi.fn()
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

vi.mock('~/composables/useTimelineCloudInfo', async () => {
  const { ref: rf } = await import('vue')
  return {
    useTimelineCloudInfo: () => ({
      info: (H.cloudInfo ??= rf(null) as unknown as { value: unknown }),
      loading: rf(false),
      refresh: H.cloudRefresh
    })
  }
})

vi.mock('~/composables/useStorageEstimate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/composables/useStorageEstimate')>()
  const { ref: rf } = await import('vue')
  return {
    ...actual,
    useStorageEstimate: () => ({
      info: (H.storageInfo ??= rf(null) as unknown as { value: unknown }),
      supported: (H.storageSupported ??= rf(false) as unknown as { value: boolean }),
      loading: rf(false),
      refresh: H.storageRefresh
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
  H.cloudInfo = null
  H.cloudRefresh.mockClear()
  H.storageInfo = null
  H.storageSupported = null
  H.storageRefresh.mockClear()
})

describe('SyncProgressBar（顶部进度条）', () => {
  it('没有同步活动时不渲染', () => {
    const wrapper = mountBar()
    expect(wrapper.find('.progress').exists()).toBe(false)
  })

  it('进行中的库按库内进度加权：拉到一半时进度条走到一半', () => {
    H.statuses = { a: { feedId: 'a', status: 'syncing', version: 0, progress: 50 } }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-value')).toBe('50')
    expect(wrapper.text()).toBe('正在同步（50%）')
  })

  it('没有 progress 的库按 0 计：完成的库满格、进行中的库不虚报', () => {
    H.statuses = {
      a: { feedId: 'a', status: 'idle', version: 1 },
      b: { feedId: 'b', status: 'syncing', version: 0 }
    }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-value')).toBe('50')
  })

  it('同步中显示体积与剩余时间：云端量级、本站缓存、预计还需多久', () => {
    H.statuses = {
      a: { feedId: 'a', status: 'syncing', version: 0, progress: 50, etaMs: 120_000 }
    }
    H.cloudInfo = {
      value: { docCount: 4965, externalSize: 796_947_140, activeSize: null, fileSize: null, updateSeq: null }
    }
    H.storageInfo = { value: { usage: 214 * 1024 * 1024, quota: null, ratio: null, persisted: null } }
    H.storageSupported = { value: true }

    const wrapper = mountBar()
    expect(wrapper.text()).toContain('正在同步（50%）')
    expect(wrapper.text()).toContain('云端 760.0 MB')
    expect(wrapper.text()).toContain('本站 214.0 MB')
    expect(wrapper.text()).toContain('预计还需 2 分钟')
    // 体积在开始时读一次（内部有缓存，连续同步不会重复请求）
    expect(H.cloudRefresh).toHaveBeenCalled()
    expect(H.storageRefresh).toHaveBeenCalled()
  })

  it('算不出剩余时间、拿不到体积时只显示百分比（不编造 0 / 空数字）', () => {
    H.statuses = { a: { feedId: 'a', status: 'syncing', version: 0, progress: 50 } }
    const wrapper = mountBar()
    expect(wrapper.text()).toBe('正在同步（50%）')
  })

  it('本地存储故障：进度条常驻并转为 error 色，显示可操作的原因', () => {
    H.storageBroken = { value: '本地缓存写入失败（存储空间不足或数据库已损坏）' }
    const wrapper = mountBar()
    expect(wrapper.find('.progress').attributes('data-color')).toBe('error')
    expect(wrapper.text()).toContain('本地缓存写入失败')
  })
})
