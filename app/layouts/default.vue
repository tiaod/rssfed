<script setup>
import { authClient } from '~~/lib/auth-client'

const { data: session, isPending, refetch } = authClient.useSession()

const handleLogout = async () => {
  await authClient.signOut()
  await refetch()
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

        <UButton
          v-if="!session?.user"
          to="/auth/login"
          variant="ghost"
          size="sm"
        >
          登录
        </UButton>

        <template v-else>
          <UDropdownMenu :items="[
            { label: '个人设置', to: '/settings' },
            { label: '退出登录', click: handleLogout, color: 'error' }
          ]">
            <UAvatar :name="session.user.name" size="sm" />
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
