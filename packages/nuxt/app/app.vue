<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

const colorMode = useColorMode()

const color = computed(() => (colorMode.value === "dark" ? "#1b1718" : "white"))

useHead({
  meta: [
    { charset: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { key: "theme-color", name: "theme-color", content: color },
  ],
  link: [{ rel: "icon", href: "/favicon.ico" }],
  htmlAttrs: {
    lang: "en",
  },
})

const title = "RSSFed"
const description = "A modern RSS reader with ActivityPub federation."

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
})

// 初始化 auth client session
authClient.useSession(useFetch)
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
