<script setup>
const userStore = useUserStore()
const _isAdmin = userStore.isAdmin
const _isPending = userStore.isPending

const _handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/auth/login')
}
</script>

<template>
  <div>
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
  </div>
</template>
