import { applyPrimaryColor } from '~/utils/siteTheme'

/**
 * 把「站点设置」里的主题色应用到 Nuxt UI 主题。
 *
 * useSiteSettings 的公开配置只在前端拉取（并命中 Service Worker 缓存），
 * 所以用 client 插件：拉取完成后覆写 `--ui-color-primary-*` 色阶。
 * 管理员保存后 useSiteSettings 内的 useState 会刷新，watch 随之重刷样式，无需刷新页面。
 */
export default defineNuxtPlugin(() => {
  const { settings } = useSiteSettings()

  watch(
    () => settings.value.primaryColor,
    color => applyPrimaryColor(document, color),
    { immediate: true }
  )
})
