<script setup>
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'Nuxt Starter Template'
const description = 'A production-ready starter template powered by Nuxt UI. Build beautiful, accessible, and performant applications in minutes, not hours.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: 'https://ui.nuxt.com/assets/templates/nuxt/starter-light.png',
  twitterImage: 'https://ui.nuxt.com/assets/templates/nuxt/starter-light.png',
  twitterCard: 'summary_large_image'
})

// 修复 USlideover 在移动端打开时的 aria-hidden 可访问性警告
// 当 #__nuxt 被设置 aria-hidden="true" 时，如果焦点仍在按钮上会导致浏览器警告
if (import.meta.client) {
  let observer = null

  onMounted(() => {
    const nuxtRoot = document.getElementById('__nuxt')
    if (!nuxtRoot) return

    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'aria-hidden') {
          const isAriaHidden = nuxtRoot.getAttribute('aria-hidden') === 'true'

          // 当 aria-hidden 被设置为 true 时，清空当前焦点
          if (isAriaHidden && document.activeElement && 'blur' in document.activeElement) {
            // 如果当前焦点在某个元素上，将焦点移走
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
    <NuxtLoadingIndicator />
    <UMain>    
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </UMain>
  </UApp>
</template>
