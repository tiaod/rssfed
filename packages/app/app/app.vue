<script setup lang="ts">
import { authClient } from "~/lib/auth-client"

const { data: session } = await authClient.useSession(useFetch)

async function handleLogout() {
  await authClient.signOut()
  await navigateTo("/login")
}

useHead({
  meta: [
    { name: "viewport", content: "width=device-width, initial-scale=1" }
  ],
  link: [
    { rel: "icon", href: "/favicon.ico" }
  ],
  htmlAttrs: {
    lang: "zh-CN"
  }
})

useSeoMeta({
  title: "RSSFed",
  description: "支持 ActivityPub 的 RSS 阅读器",
})
</script>

<template>
  <UApp>
    <UHeader>
      <template #left>
        <NuxtLink to="/" class="font-bold text-lg">
          RSSFed
        </NuxtLink>
      </template>

      <template #right>
        <UColorModeButton />

        <template v-if="session">
          <span class="text-sm text-muted hidden sm:inline">
            {{ session.user.name ?? session.user.email }}
          </span>
          <UButton
            variant="ghost"
            color="neutral"
            @click="handleLogout"
          >
            退出
          </UButton>
        </template>

        <template v-else>
          <UButton
            to="/login"
            variant="subtle"
            color="primary"
          >
            登录
          </UButton>
        </template>
      </template>
    </UHeader>

    <UMain>
      <NuxtPage />
    </UMain>

    <USeparator />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          RSSFed &bull; {{ new Date().getFullYear() }}
        </p>
      </template>
    </UFooter>
  </UApp>
</template>
