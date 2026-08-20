import type { SiteSettingsPublic } from '~/types/site'
import { useApi } from '~/composables/useApi'

// 模块级标记：站点品牌配置只需 bootstrap 拉取一次，避免多组件使用各自重复请求
let bootstrapped = false

/**
 * 站点品牌配置（公开部分）：启动时经 /api/site-settings 拉取一次，存于 useState
 * 供各页渲染 logo/主题色/皮肤。该请求命中 Service Worker network-first 缓存（见
 * public/sw.js），离线时直接用缓存，无需本地二次持久化。
 * 管理员保存后用 refresh() 主动刷新以即时生效。
 */
export function useSiteSettings() {
  const settings = useState<SiteSettingsPublic>('site-settings', () => ({}))

  /** 从服务端拉取最新品牌配置；失败（离线且无缓存）时保持现有值，回退内置默认 */
  async function refresh() {
    try {
      settings.value = await useApi().siteSettings.get()
    } catch {
      // 离线且无缓存时静默保留现有值
    }
  }

  if (import.meta.client && !bootstrapped) {
    bootstrapped = true
    void refresh()
  }

  return { settings, refresh }
}
