<script setup lang="ts">
// 离线外壳页。
//
// Service Worker 在「导航请求断网、且本地没有同一路径的 HTML 缓存」时返回本页的静态 HTML
// （构建时预渲染，见 nuxt.config.ts 的 nitro.prerender）。此时地址栏里仍是用户要去的路径，
// Nuxt 在客户端接管后会按真实 URL 渲染对应路由 —— 相关 chunk 已在预缓存里，数据来自本地
// PouchDB，所以正常情况下用户直接看到目标页面，不会停留在这一页。
// 只有目标路由也渲染不出来（例如访问了从未打开过的页面）时，才会看到下面的提示。
definePageMeta({
  layout: false
})

/**
 * 本页被当作某个路径的离线回退时，Service Worker 会把用户原本要访问的路径注入
 * window.__OFFLINE_REQUESTED_PATH__（见 public/sw.js）。这里在客户端接管后自动导航过去：
 * 目标页面的 chunk 已经在预缓存里，数据来自本地 PouchDB，通常能直接打开。
 * 只有导航不过去（例如那个页面从未被访问过）时，才会停留在本页的提示界面。
 */
onMounted(async () => {
  const requested = (window as unknown as { __OFFLINE_REQUESTED_PATH__?: string }).__OFFLINE_REQUESTED_PATH__
  if (!requested) return
  if (requested === window.location.pathname + window.location.search) return
  try {
    await navigateTo(requested, { replace: true })
  } catch {
    // 导航失败就留在本页，至少给用户一个「离线模式」的明确提示
  }
})
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center gap-6 p-6 text-center">
    <UIcon
      name="i-lucide-wifi-off"
      class="size-12 text-muted"
    />

    <div class="space-y-2">
      <h1 class="text-2xl font-bold">
        当前处于离线状态
      </h1>
      <p class="text-muted max-w-md">
        已经同步到本机的条目仍然可以阅读，已读和收藏的操作也会保留，联网后自动同步。
      </p>
    </div>

    <div class="flex flex-wrap items-center justify-center gap-3">
      <UButton
        to="/timeline"
        icon="i-lucide-activity"
        color="primary"
      >
        打开时间线
      </UButton>
      <UButton
        to="/"
        icon="i-lucide-house"
        variant="subtle"
      >
        回到主页
      </UButton>
    </div>
  </div>
</template>
