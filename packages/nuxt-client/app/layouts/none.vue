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
    <!-- 关掉 UHeader 的移动端菜单按钮：公开布局只有 logo / 深浅色 / 登录，没有可折叠的导航项。
         开着的话点出来的是一个 menu 模式弹窗，而这里既没给 #body，弹窗里就只有「顶栏副本」，
         标题还是未翻译的 header.title —— 纯噪音。将来公开页真的长出多条导航再连带 #body 一起加 -->
    <UHeader :toggle="false">
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
