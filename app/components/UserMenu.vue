<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const userStore = useUserStore()
const user = userStore.user

const _props = defineProps<{
  collapsed: boolean
}>()

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/auth/login')
}

const items = computed(() => {
  const baseItems: DropdownMenuItem[][] = [
    [
      {
        label: '个人资料',
        icon: 'i-lucide-user',
        to: '/profile'
      },
      {
        label: '设置',
        icon: 'i-lucide-settings',
        to: '/settings/general'
      }
    ],
    [
      {
        label: '退出登录',
        icon: 'i-lucide-log-out',
        color: 'error',
        onSelect: handleLogout
      }
    ]
  ]
  return baseItems
})
</script>

<template>
  <UDropdownMenu :items="items">
    <UButton
      variant="ghost"
      :size="collapsed ? 'xs' : 'sm'"
      class="w-full justify-start"
    >
      <UAvatar
        v-if="user?.image"
        :src="user.image"
        :alt="user.name"
        size="xs"
      />
      <UAvatar
        v-else
        :text="user?.name?.[0] || 'U'"
        size="xs"
        color="primary"
      />
      <span
        v-if="!collapsed"
        class="ml-2 truncate"
      >
        {{ user?.name || user?.email }}
      </span>
      <UIcon
        v-if="!collapsed"
        name="i-lucide-chevron-right"
        class="ml-auto size-4 text-muted"
      />
    </UButton>
  </UDropdownMenu>
</template>
