import { ref } from 'vue'
import type { TimelineSettings } from '~/utils/timelineSettings'
import { DEFAULT_TIMELINE_SETTINGS, normalizeTimelineSettings } from '~/utils/timelineSettings'

/**
 * 时间线聚合设置（每用户一份，存在服务端）。
 *
 * 与 useSettings（localStorage 里的浏览器本地偏好）分开：这些设置直接决定**服务端**怎么替
 * 这个用户聚合条目（窗口、图片预算、AI 开关），跟着账号走、在所有设备上一致，
 * 因此必须走接口读写，不能落 localStorage。
 *
 * 图片参数变更会触发服务端**重建**派生库（已聚合条目的附件是按旧参数压的），所以 save()
 * 会把 `rebuildQueued` 透出来，让调用方提示「正在后台重算」。
 */
export function useTimelineSettings() {
  const api = useApi()

  const settings = ref<TimelineSettings>({ ...DEFAULT_TIMELINE_SETTINGS })
  /** 是否已成功读到服务端设置（false 时页面用默认值渲染，不要据此发 PATCH） */
  const loaded = ref(false)
  const saving = ref(false)
  const rebuilding = ref(false)
  const error = ref<string | null>(null)

  /** 读取服务端设置（进入设置页时调用一次） */
  async function load(): Promise<void> {
    try {
      const res = await api.timeline.settings()
      settings.value = normalizeTimelineSettings(res.settings)
      loaded.value = true
      error.value = null
    } catch (e: unknown) {
      // 离线时保留默认值渲染，让页面仍可读；保存会另行报错
      error.value = errorMessage(e, '读取时间线设置失败')
    }
  }

  /** 保存设置；返回服务端是否因此入队了一次重建 */
  async function save(patch: Partial<TimelineSettings>): Promise<{ rebuildQueued: boolean }> {
    saving.value = true
    try {
      const res = await api.timeline.updateSettings(patch)
      settings.value = normalizeTimelineSettings(res.settings)
      loaded.value = true
      error.value = null
      return { rebuildQueued: res.rebuildQueued === true }
    } finally {
      saving.value = false
    }
  }

  /** 手动重建派生库（图片参数或窗口改动后想立刻看到效果时用） */
  async function rebuild(): Promise<void> {
    rebuilding.value = true
    try {
      await api.timeline.rebuild()
    } finally {
      rebuilding.value = false
    }
  }

  return { settings, loaded, saving, rebuilding, error, load, save, rebuild }
}
