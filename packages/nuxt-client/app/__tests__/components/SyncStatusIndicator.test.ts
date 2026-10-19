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

// 只替换掉指示器真正依赖的几样东西：同步状态、暂停开关、本地存储故障、手动同步、体积信息
const H = vi.hoisted(() => ({
  statuses: null as Record<string, { status: string, version: number, lastSyncedAt?: string, progress?: number, docsWritten?: number, etaMs?: number }> | null,
  paused: null as { value: boolean } | null,
  storageBroken: null as { value: string | null } | null,
  pauseSync: vi.fn(),
  resumeSync: vi.fn(),
  resetLocalData: vi.fn(async () => {}),
  sync: vi.fn(),
  toastAdd: vi.fn(),
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

/** 弹层里的明细行：标题是 font-medium、底部是 text-dimmed，都不带 text-muted */
function detailLines(wrapper: ReturnType<typeof mountIndicator>) {
  return wrapper.findAll('span.text-muted').map(s => s.text())
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
  H.cloudInfo = null
  H.cloudRefresh.mockClear()
  H.storageInfo = null
  H.storageSupported = null
  H.storageRefresh.mockClear()
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

  /**
   * 明细行是纯文本，文本本身会重复：并发上限是 2，两个源都还没报进度时两行都是「已同步 0%」。
   * 曾经拿行文本当 `:key`：重复 key 会让 Vue 的 keyed diff 把两个旧节点解析到同一个新节点上，
   * 先被解析的那个节点就此失去引用 —— 留在弹层里，之后再也清理不掉（真机 484 个源的同步里
   * 实测到：同步成功后弹层里还挂着几行「已同步 0%」）。
   */
  it('明细行会重复时：重渲染不留孤儿节点', async () => {
    const wrapper = mountIndicator()
    H.statuses!['feed-a'] = { status: 'syncing', version: 0, progress: 0 }
    H.statuses!['feed-b'] = { status: 'syncing', version: 0, progress: 0 }
    await wrapper.vm.$nextTick()
    expect(detailLines(wrapper)).toEqual([
      '剩余 2 / 2 个同步目标（0%）',
      '已同步 0%',
      '已同步 0%'
    ])

    // 后一个源先报进度：两行不再相同，同时「剩余 …」的百分比也前进了 —— 撞 key 的正是这一步
    H.statuses!['feed-b'] = { status: 'syncing', version: 0, progress: 30, docsWritten: 60 }
    await wrapper.vm.$nextTick()
    expect(detailLines(wrapper)).toEqual([
      '剩余 2 / 2 个同步目标（15%）',
      '已同步 0%',
      '已同步 30%（60 条）'
    ])

    // 两个库都结束 → 成功态：只剩「上次同步」一行，多一行都不许有
    const now = new Date().toISOString()
    H.statuses!['feed-a'] = { status: 'idle', version: 1, lastSyncedAt: now }
    H.statuses!['feed-b'] = { status: 'idle', version: 1, lastSyncedAt: now }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('同步成功')
    expect(detailLines(wrapper)).toEqual(['上次同步：刚刚'])
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

  it('弹层里报云端库体积（external）与本站缓存占用，并说明两个数字的口径不同', async () => {
    H.cloudInfo = {
      value: { docCount: 4965, externalSize: 796_947_140, activeSize: null, fileSize: null, updateSeq: null }
    }
    H.storageInfo = { value: { usage: 214 * 1024 * 1024, quota: null, ratio: null, persisted: null } }
    H.storageSupported = { value: true }

    const wrapper = mountIndicator()
    await wrapper.vm.$nextTick()

    // 云端报的是库的活数据量（external），本地报的是整站缓存；两个数字分开写，不混成一句话
    expect(detailLines(wrapper)).toContain('云端库 760.0 MB · 4965 条')
    expect(detailLines(wrapper)).toContain('本站缓存 214.0 MB')
    // 挂载时读一次（悬停还会再刷新，见 refreshSizes）
    expect(H.cloudRefresh).toHaveBeenCalled()
    expect(H.storageRefresh).toHaveBeenCalled()
  })

  it('体积拿不到时这两行都不出现（不显示 0 B）', async () => {
    const wrapper = mountIndicator()
    await wrapper.vm.$nextTick()
    expect(detailLines(wrapper).some(line => line.includes('云端库') || line.includes('本站缓存'))).toBe(false)
  })

  it('明细行带剩余时间估算：有 etaMs 才拼「预计还需」，没有就不出现', async () => {
    const wrapper = mountIndicator()
    H.statuses!['feed-a'] = { status: 'syncing', version: 0, progress: 30, docsWritten: 60, etaMs: 120_000 }
    await wrapper.vm.$nextTick()
    expect(detailLines(wrapper)).toContain('已同步 30%（60 条），预计还需 2 分钟')

    // 服务端没给余量 / 样本不足：状态里没有 etaMs，文案回到不带预计的样子
    H.statuses!['feed-a'] = { status: 'syncing', version: 0, progress: 30, docsWritten: 60 }
    await wrapper.vm.$nextTick()
    expect(detailLines(wrapper)).toContain('已同步 30%（60 条）')
  })
})
