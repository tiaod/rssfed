<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { useUserStore } from '~/stores/user'

const userStore = useUserStore()
const route = useRoute()
const toast = useToast()

// 初始化用户 session — 在客户端挂载后刷新，确保登录/登出后状态正确
const client = useAuthClient()
onMounted(async () => {
  await userStore.refresh()
})

const open = ref(false)
const notificationsOpen = ref(false)

const navItems = computed<NavigationMenuItem[]>(() => {
  const items: NavigationMenuItem[] = [
    {
      label: '主页',
      icon: 'i-lucide-house',
      to: '/',
      onSelect: () => { open.value = false }
    },
    {
      label: '时间线',
      icon: 'i-lucide-activity',
      to: '/timeline',
      onSelect: () => { open.value = false }
    },
    {
      label: '机器人',
      icon: 'i-lucide-bot',
      to: '/bots',
      onSelect: () => { open.value = false }
    },
    {
      label: '我的',
      icon: 'i-lucide-user',
      to: '/profile',
      onSelect: () => { open.value = false }
    },
    {
      label: '设置',
      icon: 'i-lucide-settings',
      to: '/settings',
      onSelect: () => { open.value = false }
    }
  ]

  // 管理员额外入口
  if (userStore.isAdmin) {
    items.push({
      label: '订阅源管理',
      icon: 'i-lucide-shield',
      to: '/admin/feeds',
      onSelect: () => { open.value = false }
    })
  }

  return items
})

const bottomNavItems = computed(() => navItems.value.map(item => ({
  label: item.label as string,
  icon: item.icon as string,
  to: item.to as string
})))

const isBottomNavActive = (to: string) => {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <AppLogo :class="collapsed ? 'w-8 h-8' : 'w-28 h-8'" />
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :collapsed="collapsed"
          :items="navItems"
          orientation="vertical"
          tooltip
          popover
        />
        <FeedNavigation :collapsed="collapsed" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-row gap-2">
          <UTooltip
            text="通知"
            :shortcuts="['N']"
            :disabled="!collapsed"
          >
            <UButton
              color="neutral"
              variant="ghost"
              :class="[
                collapsed ? 'px-0 w-full justify-center' : 'square'
              ]"
              @click="() => { notificationsOpen = !notificationsOpen }"
            >
              <UChip
                color="error"
                inset
              >
                <UIcon
                  name="i-lucide-bell"
                  class="size-5 shrink-0"
                />
              </UChip>
            </UButton>
          </UTooltip>
          <UserMenu :collapsed="collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <nav class="fixed bottom-0 left-0 right-0 z-50 border-t border-default bg-background/95 backdrop-blur sm:hidden">
      <div class="flex items-center justify-around py-1.5">
        <NuxtLink
          v-for="item in bottomNavItems"
          :key="item.to"
          :to="item.to"
          class="flex flex-row gap-1 items-center rounded-lg px-3 py-1.5 transition-colors"
          :class="isBottomNavActive(item.to) ? 'text-primary' : 'text-muted'"
        >
          <UIcon
            :name="item.icon"
            class="size-4"
          />
          <span class="text-xs font-normal">{{ item.label }}</span>
        </NuxtLink>
      </div>
    </nav>

    <NotificationsSlideover v-model:open="notificationsOpen" />
  </UDashboardGroup>
</template>
