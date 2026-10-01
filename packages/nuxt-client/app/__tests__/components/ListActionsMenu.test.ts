import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { DropdownMenuItem } from '@nuxt/ui'
import ListActionsMenu from '../../components/ListActionsMenu.vue'

/**
 * 列表页右上角的「三个点」菜单。
 *
 * 盯三件事：菜单内容按页面能力拼（订阅类动作只在单源 / bot 页出现）、
 * 每个动作抛对事件、同步的转圈与失败反馈落在触发按钮上。
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
      statusText: ref('上次同步：3 分钟前'),
      tooltipText: ref('上次同步：3 分钟前'),
      sync: H.sync
    })
  }
})

const STUBS = {
  UDropdownMenu: {
    name: 'DropdownMenu',
    props: ['items', 'content'],
    template: '<div class="menu"><slot /></div>'
  },
  UButton: {
    name: 'Button',
    props: ['icon', 'title', 'ariaLabel', 'variant', 'color', 'size', 'loading'],
    template: '<button class="trigger" :data-icon="icon" :data-loading="String(loading)" :data-color="color" />'
  }
}

function mountMenu(props: Record<string, unknown> = {}) {
  return mount(ListActionsMenu, { props, global: { stubs: STUBS } })
}

function groups(wrapper: ReturnType<typeof mountMenu>): DropdownMenuItem[][] {
  return wrapper.findComponent({ name: 'DropdownMenu' }).props('items') as DropdownMenuItem[][]
}

function labels(wrapper: ReturnType<typeof mountMenu>): string[][] {
  return groups(wrapper).map(group => group.map(item => item.label ?? ''))
}

function itemOf(wrapper: ReturnType<typeof mountMenu>, label: string): DropdownMenuItem {
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

describe('ListActionsMenu 菜单内容', () => {
  it('聚合页（没有订阅源）：只有同步与全部标记为已读', () => {
    const wrapper = mountMenu()

    expect(labels(wrapper)).toEqual([['同步订阅', '全部标记为已读']])
  })

  it('单源页：刷新订阅 + 编辑订阅 + 全部标记为已读 ｜ 取消订阅', () => {
    const wrapper = mountMenu({ feedId: 'feed-1', syncLabel: '刷新订阅' })

    expect(labels(wrapper)).toEqual([
      ['刷新订阅', '编辑订阅', '全部标记为已读'],
      ['取消订阅']
    ])
  })

  it('bot 产出页未订阅时第二组是「订阅」', () => {
    const wrapper = mountMenu({ feedId: 'bot:1', syncLabel: '刷新订阅', subscribed: false })

    expect(labels(wrapper)[1]).toEqual(['订阅'])
  })

  it('列表为空时禁用「全部标记为已读」', () => {
    expect(itemOf(mountMenu({ hasEntries: false }), '全部标记为已读').disabled).toBe(true)
    expect(itemOf(mountMenu({ hasEntries: true }), '全部标记为已读').disabled).toBe(false)
  })

  it('同步项把状态文案作为描述（上次同步时间 / 错误详情）', () => {
    expect(itemOf(mountMenu(), '同步订阅').description).toBe('上次同步：3 分钟前')
  })
})

describe('ListActionsMenu 动作', () => {
  it('各动作抛对应事件', () => {
    const wrapper = mountMenu({ feedId: 'feed-1' })

    itemOf(wrapper, '编辑订阅').onSelect?.(new Event('select'))
    itemOf(wrapper, '全部标记为已读').onSelect?.(new Event('select'))
    itemOf(wrapper, '取消订阅').onSelect?.(new Event('select'))

    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('mark-all-read')).toHaveLength(1)
    expect(wrapper.emitted('unsubscribe')).toHaveLength(1)
  })

  it('未订阅时「订阅」抛 subscribe', () => {
    const wrapper = mountMenu({ feedId: 'bot:1', subscribed: false })

    itemOf(wrapper, '订阅').onSelect?.(new Event('select'))

    expect(wrapper.emitted('subscribe')).toHaveLength(1)
    expect(wrapper.emitted('unsubscribe')).toBeUndefined()
  })

  it('点同步项：结果原样抛出；空转（上一轮还在跑）不发事件', async () => {
    H.sync.mockResolvedValue(OUTCOME)
    const wrapper = mountMenu()

    itemOf(wrapper, '同步订阅').onSelect?.(new Event('select'))
    await flushPromises()
    expect(wrapper.emitted('synced')).toEqual([[OUTCOME]])

    H.sync.mockResolvedValue(null)
    itemOf(mountMenu(), '同步订阅').onSelect?.(new Event('select'))
    await flushPromises()
    expect(H.sync).toHaveBeenCalledTimes(2)
  })
})

describe('ListActionsMenu 触发按钮', () => {
  it('同步中：按钮转圈、同步项禁用且文案变「同步中…」', async () => {
    // 必须是真 ref：模板只对 ref 做自动解包
    H.syncing = ref(true) as unknown as { value: boolean }
    const wrapper = mountMenu()
    await nextTick()

    expect(wrapper.get('.trigger').attributes('data-loading')).toBe('true')
    expect(itemOf(wrapper, '同步中…').disabled).toBe(true)
  })

  it('同步失败：按钮变红并换成警告图标', async () => {
    H.hasError = ref(true) as unknown as { value: boolean }
    const wrapper = mountMenu()
    await nextTick()

    const trigger = wrapper.get('.trigger')
    expect(trigger.attributes('data-color')).toBe('error')
    expect(trigger.attributes('data-icon')).toBe('i-lucide-alert-circle')
  })

  it('正常情况下是三个点', () => {
    expect(mountMenu().get('.trigger').attributes('data-icon')).toBe('i-lucide-ellipsis-vertical')
  })
})
