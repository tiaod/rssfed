import { ref } from 'vue'
import type { TimelineSettings } from '~/utils/timelineSettings'
import { DEFAULT_TIMELINE_SETTINGS, normalizeTimelineSettings } from '~/utils/timelineSettings'

/**
 * 时间线设置（每用户一份，存在服务端）。
 *
 * 与 useSettings（localStorage 里的浏览器本地偏好）分开：这些设置是**服务端**每个用户一份
 * （目前只有 AI 开关），跟着账号走、在所有设备上一致，因此必须走接口读写，不能落 localStorage。
 *
 * 图片不是用户设置：它在抓取时按全局策略压好，用户没有可调参数。
 */
export function useTimelineSettings() {
  const api = useApi()

  const settings = ref<TimelineSettings>({ ...DEFAULT_TIMELINE_SETTINGS })
  /** 是否已成功读到服务端设置（false 时页面用默认值渲染，不要据此发 PATCH） */
  const loaded = ref(false)
  const saving = ref(false)
  const rebuilding = ref(false)
  const error = ref<string | null>(null)

  /** 读取服务端设置（打开设置的「常规」分区时调用一次） */
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

  /** 保存设置（只落存储位；抓什么内容不由设置决定） */
  async function save(patch: Partial<TimelineSettings>): Promise<void> {
    saving.value = true
    try {
      const res = await api.timeline.updateSettings(patch)
      settings.value = normalizeTimelineSettings(res.settings)
      loaded.value = true
      error.value = null
    } finally {
      saving.value = false
    }
  }

  /**
   * 重新抓取这个用户的全部订阅（运维兜底入口）。
   *
   * 服务端的 `/api/timeline/rebuild` 现在**只是「绕开缓存、把全部订阅入队抓一遍」**
   * （与 `POST /refresh?force=1` 等价），**不换库**：新模型里用户库就是唯一真相，
   * 没有派生库可以清空重搬。所以这里不需要等库名变化，也不需要丢本地缓存 ——
   * 新抓到的条目照常由 live 复制落到本地。
   *
   * 曾经的实现会轮询 60 秒等服务端换库名（旧模型的重建确实是换库），换库那一步删掉之后
   * 这段等待只会让按钮空转一分钟然后什么也不发生，所以一并去掉。
   */
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
