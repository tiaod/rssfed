import type { SiteSettingsPublic } from '~/types/site'
import { useApi } from '~/composables/useApi'
import { useSiteSettings } from '~/composables/useSiteSettings'

/**
 * SSR 预取的进程内缓存时长。
 *
 * 站点配置几乎不变，但每个页面渲染都要用它：不加缓存时每次刷新/首屏都要多打一次
 * 后端。10s 足够让同一会话里的连续导航共用一份，又不会让管理员改完配置后长时间
 * 看到旧值；当前页面/客户端另有挂载后的 refresh 立即纠正（见 useSiteSettings）。
 */
const CACHE_TTL_MS = 10_000

let cached: { settings: SiteSettingsPublic; fetchedAt: number } | null = null

/**
 * SSR 首屏的站点品牌配置。
 *
 * 之前配置只在客户端拉取：服务端不知道 logoUrl，首帧渲染内置 logo，挂载后才换成
 * 配置的图 —— 每次刷新都能看到默认 logo 一闪而过。这里在渲染前取一次（公开接口、
 * 免登录），结果随 payload 传给客户端，hydration 两侧一致，首帧即是配置的 logo。
 *
 * 失败（后端暂不可达 / 超时）时静默保持空配置：首帧回退内置默认，客户端挂载后
 * 仍会 refresh，离线时再由 localStorage 快照兜底（见 useSiteSettings）。
 */
export default defineNuxtPlugin(async () => {
  const { settings, ready } = useSiteSettings()

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    settings.value = { ...cached.settings }
    ready.value = true
    return
  }

  try {
    // 3s 上限：站点配置很轻，正常内网/反代往返远低于它；超时也不该把首屏渲染拖死
    const fresh = await useApi().siteSettings.get({ timeout: 3000 })
    settings.value = fresh
    ready.value = true
    // 存副本：settings.value 是本请求的响应式对象，缓存不应跨请求共享同一引用
    cached = { settings: { ...fresh }, fetchedAt: Date.now() }
  } catch {
    // 后端不可达：首帧回退内置默认，客户端挂载后的 refresh 会再试一次
  }
})
