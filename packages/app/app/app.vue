<script setup lang="ts">
import { useUserStore } from "~/stores/user"

const userStore = useUserStore()

// SSR 友好的初始 session 加载
const { data: initialSession } = await useAuthClient().useSession(useFetch)
// 将 SSR 拿到的 session 同步到 store（仅首次加载时生效）
if (initialSession.value?.user && !userStore.user) {
  await userStore.refresh()
}

async function handleLogout() {
  await userStore.logout()
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

        <template v-if="userStore.user">
          <span class="text-sm text-muted hidden sm:inline">
            {{ userStore.user.name ?? userStore.user.email }}
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
