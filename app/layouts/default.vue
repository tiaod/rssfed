<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const route = useRoute()
const toast = useToast()

const open = ref(false)
const notificationsOpen = ref(false)

// 侧边栏导航
const navItems = [
  {
    label: '主页',
    icon: 'i-lucide-house',
    to: '/',
    onSelect: () => {
      open.value = false
    }
  },
  {
    label: '动态',
    icon: 'i-lucide-activity',
    to: '/timeline',
    onSelect: () => {
      open.value = false
    }
  },
  {
    label: '消息',
    icon: 'i-lucide-bell',
    to: '/notifications',
    onSelect: () => {
      open.value = false
    }
  },
  {
    label: '我的',
    icon: 'i-lucide-user',
    to: '/profile',
    onSelect: () => {
      open.value = false
    }
  }
] satisfies NavigationMenuItem[]

// 底部导航
const bottomNavItems = [
  { label: '主页', icon: 'i-lucide-house', to: '/' },
  { label: '动态', icon: 'i-lucide-activity', to: '/timeline' },
  { label: '消息', icon: 'i-lucide-bell', to: '/notifications' },
  { label: '我的', icon: 'i-lucide-user', to: '/profile' }
]

const isBottomNavActive = (to: string) => {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(to + '/')
}

const groups = computed(() => [{
  id: 'links',
  label: 'Go to',
  items: navItems
}, {
  id: 'code',
  label: 'Code',
  items: [{
    id: 'source',
    label: 'View page source',
    icon: 'i-simple-icons-github',
    to: `https://github.com/nuxt-ui-templates/dashboard/blob/main/app/pages${route.path === '/' ? '/index' : route.path}.vue`,
    target: '_blank'
  }]
}])

onMounted(async () => {
  const cookie = useCookie('cookie-consent')
  if (cookie.value === 'accepted') {
    return
  }

  toast.add({
    title: 'We use first-party cookies to enhance your experience on our website.',
    duration: 0,
    close: false,
    actions: [{
      label: 'Accept',
      color: 'neutral',
      variant: 'outline',
      onClick: () => {
        cookie.value = 'accepted'
      }
    }, {
      label: 'Opt out',
      color: 'neutral',
      variant: 'ghost'
    }]
  })
})
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      class="bg-elevated/25 hidden sm:block"
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
              @click="notificationsOpen = !notificationsOpen"
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

    <UDashboardSearch :groups="groups" />

    <slot />

    <!-- 手机端底部导航 -->
    <nav class="fixed bottom-0 left-0 right-0 z-50 border-t border-default bg-background/95 backdrop-blur sm:hidden">
      <div class="flex items-center justify-around py-2">
        <NuxtLink
          v-for="item in bottomNavItems"
          :key="item.to"
          :to="item.to"
          class="flex flex-col items-center gap-1 rounded-lg px-3 py-2 transition-colors"
          :class="isBottomNavActive(item.to) ? 'text-primary' : 'text-muted'"
        >
          <UIcon
            :name="item.icon"
            class="size-6"
          />
          <span class="text-xs font-medium">
            {{ item.label }}
          </span>
        </NuxtLink>
      </div>
    </nav>

    <NotificationsSlideover v-model:open="notificationsOpen" />
  </UDashboardGroup>
</template>
