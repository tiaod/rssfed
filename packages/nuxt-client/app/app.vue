<script setup lang="ts">
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
