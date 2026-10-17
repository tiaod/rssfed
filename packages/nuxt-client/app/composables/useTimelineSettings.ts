import { ref } from 'vue'
import { TIMELINE_ID, useCouchTargets } from '~/composables/useCouchTargets'
import type { TimelineSettings } from '~/utils/timelineSettings'
import { DEFAULT_TIMELINE_SETTINGS, normalizeTimelineSettings } from '~/utils/timelineSettings'

/**
 * 时间线聚合设置（每用户一份，存在服务端）。
 *
 * 与 useSettings（localStorage 里的浏览器本地偏好）分开：这些设置直接决定**服务端**怎么替
 * 这个用户聚合条目（AI 开关），跟着账号走、在所有设备上一致，
 * 因此必须走接口读写，不能落 localStorage。
 *
 * 图片不是用户设置：它按源（per-feed）在抓取时压好，管理员在订阅源管理里调。
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

  /** 保存设置（服务端会顺手催一次聚合，让改动尽快反映到派生库） */
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
   * 手动重建聚合库（运维兜底入口）。
   *
   * 服务端的重建是**换一个聚合库**（复制是变更投递不是投影，就地清空搬不回来，见 hono-server
   * 的 services/timeline.ts），而且是异步入队的：库名要过一会儿才变。本地那份是它的镜像，
   * 直接接着同步会有两个问题 ——
   *   ① 寻址缓存的还是旧库名，同步会打到一个已经不存在的库上；
   *   ② 本地为「被剪掉的条目」留着删除记录（tombstone，修订号更高），重建搬回来的内容在本地
   *      会被判成冲突、看不见。
   * 所以这里等库名真的换过去，再重挂 live 复制 —— 挂载时会发现远端地址变了、丢掉本地旧镜像重新
   * 全量拉一遍（只动本地，服务端那份才是权威）。等不到就算了：同步通道自己会重试，用户也可以再点一次。
   */
  async function rebuild(): Promise<void> {
    rebuilding.value = true
    try {
      const { dbNameFor, invalidate } = useCouchTargets()
      const before = await dbNameFor(TIMELINE_ID).catch(() => null)
      await api.timeline.rebuild()
      if (!before) return
      // 重建在服务端是异步入队的（202），库名要等它跑起来才变；最多等 60s
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        invalidate()
        const current = await dbNameFor(TIMELINE_ID).catch(() => null)
        if (current && current !== before) {
          // 换库后的收尾统一在同步挂载里做：它发现远端地址变了会丢掉本地旧镜像重新全量拉一遍
          await usePouchDb().ensureTimelineLiveSync(true)
          return
        }
      }
    } finally {
      rebuilding.value = false
    }
  }

  return { settings, loaded, saving, rebuilding, error, load, save, rebuild }
}
