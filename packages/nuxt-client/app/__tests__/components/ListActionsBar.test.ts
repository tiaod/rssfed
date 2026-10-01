import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { DropdownMenuItem } from '@nuxt/ui'
import ListActionsBar from '../../components/ListActionsBar.vue'

/**
 * 列表页右上角的动作区：〔✓ 全部标记为已读〕〔⋮ 页面动作〕。
 *
 * 盯三件事：菜单内容按页面能力拼（订阅类动作只在单源 / bot 页出现）、各动作抛对事件、
 * 以及「标记已读」按钮兼任的同步状态指示（同步中禁用转圈、失败变红）。
 */

const H = vi.hoisted(() => ({
  sync: vi.fn(),
  syncing: null as { value: boolean } | null,
  hasError: null as { value: boolean } | null
}))

vi.mock('~/composables/useSyncAction', async () => {
  const { ref } = await import('vue')
  return {
    useSyncAction: () => ({
      syncing: (H.syncing ??= ref(false) as unknown as { value: boolean }),
      hasError: (H.hasError ??= ref(false) as unknown as { value: boolean }),
      errorDetail: ref('远端 503'),
      statusText: ref('上次同步：3 分钟前'),
      tooltipText: ref('上次同步：3 分钟前'),
      sync: H.sync
    })
  }
})

const STUBS = {
  UTooltip: {
    name: 'UTooltip',
    props: ['text'],
    template: '<div class="tooltip"><span class="tooltip-text">{{ text }}</span><slot /></div>'
  },
  UDropdownMenu: {
    name: 'DropdownMenu',
    props: ['items', 'content'],
    template: '<div class="menu"><slot /></div>'
  },
  UButton: {
    name: 'Button',
    props: ['icon', 'title', 'ariaLabel', 'variant', 'color', 'size', 'loading', 'disabled'],
    template: '<button class="trigger" :data-icon="icon" :data-loading="String(loading)" :data-color="color" :disabled="disabled" :aria-label="ariaLabel" />'
  }
}

function mountBar(props: Record<string, unknown> = {}) {
  return mount(ListActionsBar, { props, global: { stubs: STUBS } })
}

/** 独立按钮：按 aria-label 找，别和 ⋮ 混了 */
function markButton(wrapper: ReturnType<typeof mountBar>) {
  return wrapper.get('button[aria-label="全部标记为已读"]')
}

function moreButton(wrapper: ReturnType<typeof mountBar>) {
  return wrapper.get('button[aria-label="更多操作"]')
}

function groups(wrapper: ReturnType<typeof mountBar>): DropdownMenuItem[][] {
  return wrapper.findComponent({ name: 'DropdownMenu' }).props('items') as DropdownMenuItem[][]
}

function labels(wrapper: ReturnType<typeof mountBar>): string[][] {
  return groups(wrapper).map(group => group.map(item => item.label ?? ''))
}

function itemOf(wrapper: ReturnType<typeof mountBar>, label: string): DropdownMenuItem {
  const hit = groups(wrapper).flat().find(item => item.label === label)
  if (!hit) throw new Error(`菜单里没有「${label}」`)
  return hit
}

const OUTCOME = { added: 1, skipped: 0, failed: 0, cancelled: 0, storageBroken: false }

beforeEach(() => {
  H.sync.mockReset()
  H.syncing = null
  H.hasError = null
})

describe('ListActionsBar 菜单内容', () => {
  it('聚合页（没有订阅源）：菜单里只剩同步', () => {
    expect(labels(mountBar())).toEqual([['同步订阅']])
  })

  it('单源页：刷新订阅 + 编辑订阅 ｜ 取消订阅', () => {
    const wrapper = mountBar({ feedId: 'feed-1', syncLabel: '刷新订阅' })

    expect(labels(wrapper)).toEqual([
      ['刷新订阅', '编辑订阅'],
      ['取消订阅']
    ])
  })

  it('bot 产出页未订阅时第二组是「订阅」', () => {
    expect(labels(mountBar({ feedId: 'bot:1', syncLabel: '刷新订阅', subscribed: false }))[1]).toEqual(['订阅'])
  })

  it('同步项把状态文案作为描述（上次同步时间 / 错误详情）', () => {
    expect(itemOf(mountBar(), '同步订阅').description).toBe('上次同步：3 分钟前')
  })
})

describe('ListActionsBar 动作', () => {
  it('各动作抛对应事件', async () => {
    const wrapper = mountBar({ feedId: 'feed-1' })

    itemOf(wrapper, '编辑订阅').onSelect?.(new Event('select'))
    itemOf(wrapper, '取消订阅').onSelect?.(new Event('select'))
    await markButton(wrapper).trigger('click')

    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('unsubscribe')).toHaveLength(1)
    expect(wrapper.emitted('mark-all-read')).toHaveLength(1)
  })

  it('未订阅时「订阅」抛 subscribe', () => {
    const wrapper = mountBar({ feedId: 'bot:1', subscribed: false })

    itemOf(wrapper, '订阅').onSelect?.(new Event('select'))

    expect(wrapper.emitted('subscribe')).toHaveLength(1)
    expect(wrapper.emitted('unsubscribe')).toBeUndefined()
  })

  it('点同步项：结果原样抛出；空转（上一轮还在跑）不发事件', async () => {
    H.sync.mockResolvedValue(OUTCOME)
    const wrapper = mountBar()

    itemOf(wrapper, '同步订阅').onSelect?.(new Event('select'))
    await flushPromises()
    expect(wrapper.emitted('synced')).toEqual([[OUTCOME]])

    H.sync.mockResolvedValue(null)
    itemOf(mountBar(), '同步订阅').onSelect?.(new Event('select'))
    await flushPromises()
    expect(H.sync).toHaveBeenCalledTimes(2)
  })
})

describe('ListActionsBar 的「全部标记为已读」按钮', () => {
  it('默认是圆勾图标，提示就是动作本身', () => {
    const wrapper = mountBar()

    expect(markButton(wrapper).attributes('data-icon')).toBe('i-lucide-circle-check')
    expect(wrapper.get('.tooltip-text').text()).toBe('全部标记为已读')
  })

  it('列表为空时禁用并说明原因', () => {
    const wrapper = mountBar({ hasEntries: false })

    expect(markButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.get('.tooltip-text').text()).toBe('当前列表没有条目')
  })

  it('同步中：转圈 + 禁用（正在写库时不该去标记），并说明原因', async () => {
    H.syncing = ref(true) as unknown as { value: boolean }
    const wrapper = mountBar()
    await nextTick()

    expect(markButton(wrapper).attributes('data-loading')).toBe('true')
    expect(markButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.get('.tooltip-text').text()).toContain('同步中')
  })

  it('同步失败：变红 + 警告图标，提示里带错误详情', async () => {
    H.hasError = ref(true) as unknown as { value: boolean }
    const wrapper = mountBar()
    await nextTick()

    expect(markButton(wrapper).attributes('data-color')).toBe('error')
    expect(markButton(wrapper).attributes('data-icon')).toBe('i-lucide-alert-circle')
    expect(wrapper.get('.tooltip-text').text()).toBe('同步失败：远端 503')
  })

  it('⋮ 始终是三个点：状态指示由标记按钮承担，不重复显示', async () => {
    H.hasError = ref(true) as unknown as { value: boolean }
    H.syncing = ref(true) as unknown as { value: boolean }
    const wrapper = mountBar()
    await nextTick()

    expect(moreButton(wrapper).attributes('data-icon')).toBe('i-lucide-ellipsis-vertical')
    expect(moreButton(wrapper).attributes('data-color')).toBe('neutral')
  })
})
