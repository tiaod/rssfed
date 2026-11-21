import { computed, ref } from 'vue'
import {
  BACKGROUND_SYNC_LOG_KEEP,
  clearBackgroundSyncEvents,
  readBackgroundSyncEvents
} from '~/utils/backgroundSyncLog'
import { summarizeBackgroundSync } from '~/utils/backgroundSyncLogFormat'
import type { BackgroundSyncEvent } from '~/utils/backgroundSyncLog'

/**
 * Background Sync 日志（设置 → 数据 →「后台同步」）。
 *
 * 与 useTimelineLog 的区别：那份读服务端 HTTP 接口、有 loading/error 需要处理；
 * 这份读本机 IndexedDB，读失败就是空数组（appendBackgroundSyncEvent 承诺永不抛），
 * 所以没有 error 状态 —— 多一个恒为 null 的 error 字段只会让模板更绕。
 *
 * 同样**不轮询**：这是排查面板，按需点「刷新」。
 */
export function useBackgroundSyncLog() {
  const events = ref<BackgroundSyncEvent[]>([])
  const loading = ref(false)
  const clearing = ref(false)
  /** 是否成功读过一次（区分「还没读」和「读了但确实没有」） */
  const loaded = ref(false)

  const summary = computed(() => summarizeBackgroundSync(events.value))

  async function load(): Promise<void> {
    loading.value = true
    try {
      events.value = await readBackgroundSyncEvents(BACKGROUND_SYNC_LOG_KEEP)
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function clear(): Promise<void> {
    clearing.value = true
    try {
      await clearBackgroundSyncEvents()
      events.value = []
      loaded.value = true
    } finally {
      clearing.value = false
    }
  }

  return { events, summary, loading, clearing, loaded, load, clear }
}
