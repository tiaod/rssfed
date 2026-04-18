<script setup>
const userStore = useUserStore()

const isAdmin = userStore.isAdmin
const isPending = userStore.isPending

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/auth/login')
}
</script>

<template>
  <UApp>
    <UHeader>
      <template #left>
        <NuxtLink to="/">
          <AppLogo class="w-auto h-6 shrink-0" />
        </NuxtLink>
      </template>

      <template #right>
        <UColorModeButton />
        <!-- 加载状态 -->
        <UButton
          v-if="isPending"
          variant="ghost"
          size="sm"
          disabled
        >
          <UIcon name="i-svg-spinners-pulse-2" />
        </UButton>
        <!-- 未登录 -->
        <UButton
          v-else-if="!userStore.isAuthenticated"
          to="/auth/login"
          variant="ghost"
          size="sm"
        >
          登录
        </UButton>
        <!-- 已登录 -->
        <template v-else>
          <UButton
            v-if="isAdmin"
            to="/admin/users"
            variant="ghost"
            size="sm"
          >
            管理后台
          </UButton>
          <UDropdownMenu
            :items="[
              { label: '个人设置', to: '/settings' },
              { label: '退出登录', click: handleLogout, color: 'error' }
            ]"
          >
            <UAvatar
              :name="userStore.user?.name"
              size="sm"
            />
          </UDropdownMenu>
        </template>
      </template>
    </UHeader>

    <UMain>
      <slot />
    </UMain>

    <USeparator icon="i-simple-icons-nuxtdotjs" />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          Built with Nuxt UI • © {{ new Date().getFullYear() }}
        </p>
      </template>

      <template #right>
        <UButton
          to="https://github.com/nuxt-ui-templates/starter"
          target="_blank"
          icon="i-simple-icons-github"
          aria-label="GitHub"
          color="neutral"
          variant="ghost"
        />
      </template>
    </UFooter>
  </UApp>
</template>
