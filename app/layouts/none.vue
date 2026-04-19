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
</template>
