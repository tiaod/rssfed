import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncStatusIndicator from '../../components/SyncStatusIndicator.vue'

/**
 * 左下角同步指示器的点击语义：
 *   1. 正在同步时点击 = 暂停同步（不再发起一次同步）；
 *   2. 已暂停时点击 = 继续同步（并立即拉一次）；
 *   3. 其余状态点击 = 立即同步。
 *
 * 状态文案（含「同步已暂停」）走 utils/syncStatusSummary 的纯函数，另有单测。
 */

// 只替换掉指示器真正依赖的几样东西：同步状态、暂停开关、本地存储故障、手动同步
const H = vi.hoisted(() => ({
  statuses: null as Record<string, { status: string, version: number, lastSyncedAt?: string }> | null,
  paused: null as { value: boolean } | null,
  storageBroken: null as { value: string | null } | null,
  pauseSync: vi.fn(),
  resumeSync: vi.fn(),
  resetLocalData: vi.fn(async () => {}),
  sync: vi.fn(),
  toastAdd: vi.fn()
}))

vi.mock('~/composables/usePouchDb', async () => {
  const { reactive: r, ref: rf } = await import('vue')
  return {
    usePouchDb: () => ({
      syncStatuses: (H.statuses ??= r({})),
      paused: (H.paused ??= rf(false) as unknown as { value: boolean }),
      storageBroken: (H.storageBroken ??= rf(null) as unknown as { value: string | null }),
      pauseSync: H.pauseSync,
      resumeSync: H.resumeSync,
      resetLocalData: H.resetLocalData
    })
  }
})

vi.mock('~/composables/useManualSync', async () => {
  const { ref: rf } = await import('vue')
  return { useManualSync: () => ({ syncing: rf(false), sync: H.sync }) }
})

// Nuxt auto-import 的 useToast：这里只关心暂停动作给出的反馈
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useToast = () => ({ add: H.toastAdd })

const STUBS = {
  UTooltip: {
    name: 'UTooltip',
    template: '<div class="tooltip"><slot /><slot name="content" /></div>'
  },
  UButton: {
    name: 'UButton',
    inheritAttrs: false,
    emits: ['click'],
    template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'
  },
  UIcon: {
    name: 'UIcon',
    props: ['name'],
    template: '<i :data-icon="name" />'
  }
}

function mountIndicator() {
  return mount(SyncStatusIndicator, { global: { stubs: STUBS } })
}

/** 造一轮同步中：一个源在跑、一个在排队 */
function setSyncing() {
  H.statuses!['feed-a'] = { status: 'syncing', version: 0 }
  H.statuses!['feed-b'] = { status: 'queued', version: 0 }
}

beforeEach(() => {
  H.statuses = null
  H.paused = null
  H.storageBroken = null
  H.pauseSync.mockClear()
  H.resumeSync.mockClear()
  H.resetLocalData.mockClear()
  H.sync.mockClear()
  H.toastAdd.mockClear()
})

describe('SyncStatusIndicator（左下角同步指示器）', () => {
  it('正在同步时点击 = 暂停同步，且不再发起一次同步', async () => {
    const wrapper = mountIndicator()
    setSyncing()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button').attributes('aria-label')).toBe('暂停同步')

    await wrapper.find('button').trigger('click')

    expect(H.pauseSync).toHaveBeenCalledTimes(1)
    expect(H.sync).not.toHaveBeenCalled()
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '已暂停同步' }))
    // 悬停提示要说明点下去会做什么
    expect(wrapper.text()).toContain('点击暂停同步')
  })

  it('已暂停时点击 = 继续同步 + 立即拉取', async () => {
    const wrapper = mountIndicator()
    H.paused!.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button').attributes('aria-label')).toBe('继续同步')
    expect(wrapper.text()).toContain('同步已暂停')
    expect(wrapper.text()).toContain('点击继续同步')

    await wrapper.find('button').trigger('click')

    expect(H.resumeSync).toHaveBeenCalledTimes(1)
    expect(H.sync).toHaveBeenCalledTimes(1)
    expect(H.pauseSync).not.toHaveBeenCalled()
  })

  it('暂停优先于同步中：仍显示已暂停，点击走恢复', async () => {
    const wrapper = mountIndicator()
    setSyncing()
    H.paused!.value = true
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('同步已暂停')

    await wrapper.find('button').trigger('click')

    expect(H.pauseSync).not.toHaveBeenCalled()
    expect(H.sync).toHaveBeenCalledTimes(1)
  })

  it('没有同步活动时点击 = 立即同步', async () => {
    const wrapper = mountIndicator()
    H.statuses!['feed-a'] = { status: 'idle', version: 1, lastSyncedAt: '2026-09-27T12:30:00.000Z' }
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button').attributes('aria-label')).toBe('立即同步')

    await wrapper.find('button').trigger('click')

    expect(H.sync).toHaveBeenCalledTimes(1)
    expect(H.pauseSync).not.toHaveBeenCalled()
  })

  it('本地存储故障：优先于同步中/暂停，点击走「重置本地缓存 + 重新同步」', async () => {
    const wrapper = mountIndicator()
    setSyncing()
    H.paused!.value = true
    H.storageBroken!.value = '本地缓存写入失败（存储空间不足或数据库已损坏）'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button').attributes('aria-label')).toBe('重置本地缓存')
    expect(wrapper.text()).toContain('本地缓存写入失败')
    expect(wrapper.text()).toContain('点击可重置本地缓存并重新同步')

    await wrapper.find('button').trigger('click')
    await vi.waitFor(() => expect(H.sync).toHaveBeenCalledTimes(1))

    expect(H.resetLocalData).toHaveBeenCalledTimes(1)
    // 重置是异步的：必须等库销毁重建完成后才发起同步，否则复制会退回同一个坏库
    expect(H.resetLocalData.mock.invocationCallOrder[0]!)
      .toBeLessThan(H.sync.mock.invocationCallOrder[0]!)
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '本地缓存已重置' }))
  })
})
