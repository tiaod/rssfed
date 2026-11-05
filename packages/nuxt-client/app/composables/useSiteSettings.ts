import type { SiteSettingsPublic } from '~/types/site'
import { useApi } from '~/composables/useApi'
import { readSiteSettingsSnapshot, writeSiteSettingsSnapshot } from '~/utils/siteSettingsSnapshot'

// 模块级标记：站点品牌配置只需 bootstrap 拉取一次，避免多组件使用各自重复请求
let bootstrapped = false

/**
 * 站点品牌配置（公开部分）：存于 useState 供各页渲染 logo/主题色/皮肤。
 *
 * 首屏来自服务端预取（plugins/site-settings.server.ts）：SSR 渲染前拉一次，
 * 结果随 payload 传给客户端，首帧就能渲染配置的 logo，不会先闪默认图再换成
 * 配置图。挂载后客户端再 refresh 一次，保证管理端改完配置能立即生效。
 *
 * 离线兜底有两层：
 *   1. 请求命中 Service Worker 的 network-first 缓存（见 public/sw.js）；
 *   2. localStorage 快照（见 utils/siteSettingsSnapshot）—— SW 缓存会随构建号整体
 *      换掉，新版本装好后第一次断网打开时第 1 层是空的，靠快照才不至于回退默认。
 * 管理员保存后用 refresh() 主动刷新，成功后同步更新快照。
 */
export function useSiteSettings() {
  const settings = useState<SiteSettingsPublic>('site-settings', () => ({}))
  /**
   * SSR 是否已经取到站点配置（随 payload 下发）。
   * 客户端据此决定挂载后还要不要再补一次请求：首屏已拿到就不再重复打后端。
   */
  const ready = useState<boolean>('site-settings-ready', () => false)

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

    // 快照与网络请求都等根组件 hydration 完成后再应用，避免它们改变首帧：
    // 首帧的形状由 SSR 预取的数据决定（没取到时是内置默认），客户端首帧必须与之
    // 逐字一致。主题色不受影响 —— 已由 head 里的内联脚本在解析阶段按快照先行写入。
    nuxtApp.hook('app:mounted', () => {
      if (snapshot) settings.value = { ...snapshot, ...settings.value }

      // SSR 首屏已拿到配置，且与本地快照的版本一致：无需再回源，只补写快照
      // （首次访问没有快照也走这里）。版本不一致说明 SSR 命中了 TTL 内的旧缓存
      // （管理员刚保存过），或本地快照更旧 —— 都回源一次。
      if (ready.value && (!snapshot || snapshot.version === settings.value.version)) {
        writeSiteSettingsSnapshot(settings.value)
        return
      }
      void refresh()
    })
  }

  return { settings, refresh, ready }
}
