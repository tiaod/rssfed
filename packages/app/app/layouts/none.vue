<script setup lang="ts">
const authClient = useAuthClient()
const { data: session } = await authClient.useSession(useFetch)

async function handleLogout() {
  await authClient.signOut()
  await navigateTo("/login")
}
</script>

<template>
  <div>
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
      <slot />
    </UMain>

    <USeparator icon="i-simple-icons-nuxtdotjs" />

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          RSSFed &bull; {{ new Date().getFullYear() }}
        </p>
      </template>
    </UFooter>
  </div>
</template>
