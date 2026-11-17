import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { SETTINGS_SECTIONS, useSettingsModal } from '../../composables/useSettingsModal'

/**
 * 设置弹窗的状态层。
 *
 * 要盯的是三件事：入口打开时落在哪个分区、关掉再打开不会记住上一次的分区（
 * 否则从「查看同步日志」进过一次后，之后每次点「设置」都落到「数据」）、
 * 以及「直接展开同步日志」这个一次性意图只被消费一次。
 */

// 复刻 Nuxt auto-import：useState 按 key 全局单例（同一 key 必须拿到同一个 ref）
const nuxtGlobals = globalThis as unknown as Record<string, unknown>
const stateCache = new Map<string, Ref<unknown>>()
nuxtGlobals.useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()) as Ref<unknown>)
  return stateCache.get(key) as Ref<T>
})

beforeEach(() => {
  // 每个用例都从全新的 useState 缓存开始，等于「重新加载页面后第一次打开设置」
  stateCache.clear()
})

describe('useSettingsModal', () => {
  it('分区清单覆盖三个分区，顺序即导航顺序', () => {
    expect(SETTINGS_SECTIONS.map(item => item.value)).toEqual(['general', 'ai', 'data'])
  })

  it('open() 默认打开常规；带参数时落在该分区', () => {
    const modal = useSettingsModal()
    expect(modal.isOpen.value).toBe(false)

    modal.open()
    expect(modal.isOpen.value).toBe(true)
    expect(modal.section.value).toBe('general')

    modal.close()
    modal.open('ai')
    expect(modal.section.value).toBe('ai')
  })

  it('openSyncLog() 直接落到数据分区，并留下「展开同步日志」的意图', () => {
    const modal = useSettingsModal()
    modal.openSyncLog()

    expect(modal.isOpen.value).toBe(true)
    expect(modal.section.value).toBe('data')
    expect(modal.consumeTimelineLogIntent()).toBe(true)
    // 意图是一次性的：数据分区消费掉之后，下次普通打开不该又自动展开
    expect(modal.consumeTimelineLogIntent()).toBe(false)
  })

  it('普通 open() 不带同步日志意图', () => {
    const modal = useSettingsModal()
    modal.open('data')

    expect(modal.consumeTimelineLogIntent()).toBe(false)
  })
})
