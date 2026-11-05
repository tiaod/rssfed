import type { SiteSettingsPublic } from '~/types/site'
import { useApi } from '~/composables/useApi'
import { readSiteSettingsSnapshot, writeSiteSettingsSnapshot } from '~/utils/siteSettingsSnapshot'

// 模块级标记：站点品牌配置只需 bootstrap 拉取一次，避免多组件使用各自重复请求
let bootstrapped = false

/**
 * 站点品牌配置（公开部分）：启动时经 /api/site-settings 拉取一次，存于 useState
 * 供各页渲染 logo/主题色/皮肤。
 *
 * 离线兜底有两层：
 *   1. 请求命中 Service Worker 的 network-first 缓存（见 public/sw.js）；
 *   2. localStorage 快照（见 utils/siteSettingsSnapshot）—— SW 缓存会随构建号整体
 *      换掉，新版本装好后第一次断网打开时第 1 层是空的，靠快照才不至于回退默认。
 * 管理员保存后用 refresh() 主动刷新，成功后同步更新快照。
 */
export function useSiteSettings() {
  const settings = useState<SiteSettingsPublic>('site-settings', () => ({}))

  /** 从服务端拉取最新品牌配置；失败（离线且无缓存）时保持现有值，回退内置默认 */
  async function refresh() {
    try {
      const fresh = await useApi().siteSettings.get()
      settings.value = fresh
      writeSiteSettingsSnapshot(fresh)
    } catch {
      // 离线且无缓存时静默保留现有值（含已恢复的本地快照）
    }
  }

  if (import.meta.client && !bootstrapped) {
    bootstrapped = true

    const snapshot = readSiteSettingsSnapshot()
    const nuxtApp = useNuxtApp()

    // 等根组件 hydration 完成后再应用配置（快照与网络请求都延后）：
    // SSR 首帧没有站点配置，渲染的是默认 logo / 无版本号的图标 URL，客户端首帧
    // 必须逐字一致，否则 img 的 src 属性甚至元素种类都会在 hydration 时对不上。
    // 主题色不受影响 —— 已由 head 里的内联脚本在解析阶段按快照先行写入。
    nuxtApp.hook('app:mounted', () => {
      if (snapshot) settings.value = { ...snapshot, ...settings.value }
      void refresh()
    })
  }

  return { settings, refresh }
}
