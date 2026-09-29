<script setup lang="ts">
import { normalizeHexColor } from '~/utils/siteTheme'

const { settings } = useSiteSettings()

/**
 * PWA 资源走固定 URL，内容由后端按站点配置动态渲染（见 hono-server 的
 * pwa/manifest.ts）。这里刻意不把配置值拼进 URL：
 * `<link rel="manifest">` 必须静态存在于 HTML 中（iOS Safari 不认 JS 动态注入的
 * manifest），且版本变化由后端在 manifest 内部用 `?v=` 处理。
 */
const MANIFEST_URL = '/api/site-settings/manifest.webmanifest'
const APPLE_TOUCH_ICON_URL = '/api/site-settings/icon/apple-touch-180.png'

/** 与后端 DEFAULT_THEME_COLOR（app.config.ts 的 green-500）对齐，配置就绪前先用它 */
const FALLBACK_THEME_COLOR = '#00c16a'

/**
 * 主题色：PWA 专项色 → 站点主色 → 内置默认。
 * 注意 useSiteSettings 只在客户端拉取配置，故首屏 SSR 拿到的是默认色 ——
 * 安装时的 theme_color 由 manifest 决定（服务端渲染，始终正确），
 * 这个 meta 只影响浏览器 UI 着色，晚一步更新无碍。
 */
const themeColor = computed(() =>
  normalizeHexColor(settings.value.pwaThemeColor)
  ?? normalizeHexColor(settings.value.primaryColor)
  ?? FALLBACK_THEME_COLOR
)

/** 主屏幕图标下的名字：短名 → 站点标题 → 应用名 */
const appTitle = computed(() =>
  settings.value.pwaShortName?.trim()
  || settings.value.siteTitle?.trim()
  || 'RSSFed'
)

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'theme-color', content: themeColor },
    // iOS 独立窗口：老版本只认 apple-mobile-web-app-capable（15.4+ 也读 manifest 的 display）
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: appTitle },
    { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    { rel: 'manifest', href: MANIFEST_URL },
    // iOS 不读 manifest 的 icons，主屏幕图标只认这条（对应后端 sharp 生成的不透明 180 图）
    { rel: 'apple-touch-icon', sizes: '180x180', href: APPLE_TOUCH_ICON_URL }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

useSeoMeta({
  title: 'RSSFed',
  description: '支持 ActivityPub 的 RSS 阅读器'
})
</script>

<template>
  <UApp>
    <SyncProgressBar />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
