<script setup>
import { onMounted, onUnmounted } from 'vue'

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

const title = 'RSSFed'
const description = 'RSS 阅读器'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})

// 注册 Service Worker（仅在客户端执行）
if (import.meta.client && 'serviceWorker' in navigator) {
  onMounted(async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js')
      console.log('ServiceWorker 注册成功:', registration.scope)
    } catch (err) {
      console.error('ServiceWorker 注册失败:', err)
    }
  })
}

const { isOffline } = useOffline()

// 修复 USlideover 在移动端打开时的 aria-hidden 可访问性警告
if (import.meta.client) {
  let observer = null

  onMounted(() => {
    const nuxtRoot = document.getElementById('__nuxt')
    if (!nuxtRoot) return

    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'aria-hidden') {
          const isAriaHidden = nuxtRoot.getAttribute('aria-hidden') === 'true'

          if (isAriaHidden && document.activeElement && 'blur' in document.activeElement) {
            document.activeElement.blur()
          }
        }
      })
    })

    observer.observe(nuxtRoot, { attributes: true })
  })

  onUnmounted(() => {
    observer?.disconnect()
  })
}
</script>

<template>
  <UApp>
    <div
      v-if="isOffline"
      class="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-white text-center text-xs py-1 font-medium"
    >
      离线模式 - 显示已缓存的内容
    </div>
    <NuxtLoadingIndicator />
    <UMain>
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </UMain>
  </UApp>
</template>
