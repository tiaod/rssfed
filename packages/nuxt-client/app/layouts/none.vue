<script setup lang="ts">
const { settings } = useSiteSettings()
const route = useRoute()

/** 站点标题：管理员配置优先，未配置时回退内置应用名（与 app.vue 的标题回退链一致） */
const siteTitle = computed(() => settings.value.siteTitle?.trim() || 'RSSFed')

const authClient = useAuthClient()
const { data: session } = await authClient.useSession(useFetch)

async function handleLogout() {
  await authClient.signOut()
  await navigateTo('/login')
}
</script>

<template>
  <div>
    <UHeader>
      <template #left>
        <NuxtLink
          to="/"
          class="font-bold text-lg"
        >
          {{ siteTitle }}
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

        <!-- 登录页自身不再显示指向自己的登录入口 -->
        <UButton
          v-else-if="route.path !== '/login'"
          to="/login"
          variant="subtle"
          color="primary"
        >
          登录
        </UButton>
      </template>
    </UHeader>

    <UMain>
      <slot />
    </UMain>

    <USeparator icon="i-simple-icons-nuxtdotjs" />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          {{ siteTitle }} &bull; {{ new Date().getFullYear() }}
        </p>
      </template>
    </UFooter>
  </div>
</template>
