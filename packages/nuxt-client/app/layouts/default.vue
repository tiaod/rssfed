<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { useUserStore } from '~/stores/user'

const userStore = useUserStore()
const route = useRoute()

// 侧边栏搜索框：目前只占位，未接入任何搜索逻辑（后续做搜索时在这里接线）
const sidebarSearch = ref('')

/**
 * 视口过矮（手机横屏、超矮窗口）时把侧边栏退回「整体滚动」。
 *
 * 固定头部（logo + 搜索框 + 主导航 + 「订阅源」标题行 + 用户区）约占 350px，
 * 低于 600px 时留给订阅源列表的空间不足 250px，硬固定会把列表压成一条缝，
 * 此时让整块内容一起滚更好用。SSR 与客户端首帧都按 false 渲染（固定布局），
 * 挂载后再按真实高度切换，避免 hydration mismatch。
 */
const compactSidebar = ref(false)
function syncCompactSidebar() {
  compactSidebar.value = window.innerHeight < 600
}

// 正常：body 不滚动，只让订阅源列表内部滚动；紧凑：用主题默认的 overflow-y-auto 整块滚动。
// 间距一律用主题默认值（gap-4），不再自定义收紧
//
// footer 不再画 border-t（主题默认没有，这里也不再额外加）：用户区与订阅源列表之间
// 改用列表底部的渐隐过渡（见 FeedNavigation 的 showFade），参考 DeepSeek 侧边栏。
const sidebarUi = computed(() => ({
  body: compactSidebar.value ? undefined : 'flex-1 min-h-0 overflow-hidden'
}))

// 初始化用户 session — 在客户端挂载后刷新，确保登录/登出后状态正确
onMounted(async () => {
  syncCompactSidebar()
  window.addEventListener('resize', syncCompactSidebar)
  await userStore.refresh()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncCompactSidebar)
})

const open = ref(false)
// 通知入口暂时下线，恢复底部通知按钮时一并取消注释
// const notificationsOpen = ref(false)

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
      label: 'Bot 广场',
      icon: 'i-lucide-bot',
      to: '/bots/explore',
      onSelect: () => { open.value = false }
    },
    {
      label: '收藏',
      icon: 'i-lucide-star',
      to: '/saved',
      onSelect: () => { open.value = false }
    },
    {
      label: '我的',
      icon: 'i-lucide-user',
      to: '/profile',
      onSelect: () => { open.value = false }
    }
  ]

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
      :ui="sidebarUi"
    >
      <template #header="{ collapsed }">
        <AppLogo :class="collapsed ? 'w-8 h-8' : 'w-28 h-8'" />
      </template>

      <template #default="{ collapsed }">
        <!-- 搜索框占位：紧贴 logo 下方；暂未接搜索逻辑，折叠态隐藏 -->
        <UInput
          v-if="!collapsed"
          v-model="sidebarSearch"
          icon="i-lucide-search"
          placeholder="搜索"
          size="sm"
          class="w-full shrink-0"
        />
        <UNavigationMenu
          class="shrink-0"
          :collapsed="collapsed"
          :items="navItems"
          orientation="vertical"
          tooltip
          popover
        />
        <FeedNavigation
          :collapsed="collapsed"
          :scrollable="!compactSidebar"
        />
      </template>

      <template #footer="{ collapsed }">
        <!-- 通知按钮仍然下线，恢复时一并放开 notificationsOpen 与 NotificationsSlideover
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
        -->
        <UserMenu :collapsed="collapsed" />
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

    <!-- 通知面板暂时下线，与底部通知按钮一起恢复
    <NotificationsSlideover v-model:open="notificationsOpen" />
    -->
    <EntryDetailModal />
  </UDashboardGroup>
</template>
