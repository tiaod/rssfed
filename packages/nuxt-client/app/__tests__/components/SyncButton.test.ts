import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SyncButton from '../../components/SyncButton.vue'

/**
 * 工具栏同步按钮：点击发起手动同步，结束后把本轮结果以 `synced` 事件抛给页面。
 *
 * 那个事件是「本轮没有新条目就顺手展开列表」的触发点（见 useSyncedEntryList
 * 的 applyNewIfSyncAddedNothing），所以这里要盯住两件事：结果原样转发、
 * 空转（上一轮还在跑）时不发事件。
 */

const H = vi.hoisted(() => ({
  sync: vi.fn(),
  syncing: null as { value: boolean } | null,
  statuses: null as Record<string, unknown> | null
}))

// 只替换掉按钮真正依赖的两样东西：同步状态与手动同步入口
vi.mock('~/composables/usePouchDb', async () => {
  const { reactive: r } = await import('vue')
  return {
    usePouchDb: () => ({ syncStatuses: (H.statuses ??= r({})) })
  }
})

vi.mock('~/composables/useManualSync', async () => {
  const { ref: rf } = await import('vue')
  return {
    useManualSync: () => ({
      syncing: (H.syncing ??= rf(false) as unknown as { value: boolean }),
      sync: H.sync
    })
  }
})

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
  }
}

function mountButton() {
  return mount(SyncButton, { global: { stubs: STUBS } })
}

const OUTCOME = { added: 0, skipped: 2, failed: 0, cancelled: 0, storageBroken: false }

beforeEach(() => {
  H.statuses = null
  H.syncing = null
  H.sync.mockReset()
})

describe('SyncButton（工具栏同步按钮）', () => {
  it('点击同步结束后把本轮结果原样抛出', async () => {
    H.sync.mockResolvedValue(OUTCOME)
    const wrapper = mountButton()

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(H.sync).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('synced')).toEqual([[OUTCOME]])
  })

  it('上一轮还在跑（本轮没执行，结果为 null）→ 不抛事件', async () => {
    H.sync.mockResolvedValue(null)
    const wrapper = mountButton()

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(H.sync).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('synced')).toBeUndefined()
  })
})
