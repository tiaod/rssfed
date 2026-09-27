<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
// 显式导入：与 FeedNavigation 的 FeedIcon 一致，避免组件清单扫描不到时静默退化
import SyncStatusIndicator from '~/components/SyncStatusIndicator.vue'

const userStore = useUserStore()
// 必须保持响应式：登录 / 登出 / 换账号后 session 会更新，快照取值不会跟着刷新
const user = computed(() => userStore.user)
const isAdmin = computed(() => userStore.isAdmin)

// 明暗主题偏好（system / light / dark），由 @nuxtjs/color-mode 写入 localStorage
const colorMode = useColorMode()

const THEME_OPTIONS = [
  { label: '跟随系统', icon: 'i-lucide-monitor', value: 'system' },
  { label: '亮色', icon: 'i-lucide-sun', value: 'light' },
  { label: '暗色', icon: 'i-lucide-moon', value: 'dark' }
] as const

const _props = defineProps<{
  collapsed: boolean
}>()

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/login')
}

const displayName = computed(() => user.value?.name || user.value?.email || '未登录')

const items = computed<DropdownMenuItem[][]>(() => [
  // 注意：分组之间不需要自己写 { type: 'separator' }，Nuxt UI 的 dropdown 主题
  // 已给每个分组加了 not-last 下边框，再加一条会出现两道挨着的分割线。
  [
    {
      label: '账户资料',
      icon: 'i-lucide-user',
      to: '/profile'
    },
    {
      label: '通用设置',
      icon: 'i-lucide-settings',
      // 深链到「通用设置」标签页（?tab= 的处理见 pages/profile.vue）
      to: { path: '/profile', query: { tab: '1' } }
    }
  ],
  [
    { type: 'label', label: '主题' },
    ...THEME_OPTIONS.map(option => ({
      label: option.label,
      icon: option.icon,
      type: 'checkbox' as const,
      checked: colorMode.preference === option.value,
      // 不走 toggle 语义：点任意一项都把偏好切到该项，选中态始终由 colorMode 派生
      onUpdateChecked: () => { colorMode.preference = option.value }
    }))
  ],
  [
    {
      label: '报告问题',
      icon: 'i-lucide-circle-help',
      to: 'https://github.com/tiaod/rssfed/issues',
      target: '_blank'
    }
  ]
])
</script>

<template>
  <!-- 未登录：首页等公开页面也能用 default 布局，此时直接给登录入口，不弹菜单 -->
  <UButton
    v-if="!user"
    to="/login"
    variant="ghost"
    :size="collapsed ? 'xs' : 'sm'"
    class="w-full justify-start"
  >
    <UIcon
      name="i-lucide-log-in"
      class="size-4 shrink-0"
    />
    <span
      v-if="!collapsed"
      class="ml-2 truncate"
    >
      登录
    </span>
  </UButton>

  <div
    v-else
    class="flex w-full items-center gap-1"
  >
    <UDropdownMenu
      :items="items"
      :content="{ side: 'top', align: 'start', sideOffset: 8 }"
      :ui="{ content: 'w-72' }"
    >
      <UButton
        variant="ghost"
        :size="collapsed ? 'xs' : 'sm'"
        class="min-w-0 flex-1 justify-start"
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
          {{ displayName }}
        </span>
      </UButton>

      <!-- 菜单顶部：账户概要（头像 / 昵称 / 角色徽标 / 邮箱） -->
      <template #content-top>
        <div class="mb-1 flex items-center gap-3 border-b border-default px-3 py-2.5">
          <UAvatar
            v-if="user?.image"
            :src="user.image"
            :alt="user.name"
            size="md"
          />
          <UAvatar
            v-else
            :text="user?.name?.[0] || 'U'"
            size="md"
            color="primary"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium">{{ displayName }}</span>
              <UBadge
                :color="isAdmin ? 'primary' : 'neutral'"
                variant="subtle"
                size="xs"
              >
                {{ isAdmin ? '管理员' : '普通用户' }}
              </UBadge>
            </div>
            <p
              v-if="user?.email"
              class="truncate text-xs text-muted"
            >
              {{ user.email }}
            </p>
          </div>
        </div>
      </template>

      <!-- 菜单底部：退出登录 -->
      <template #content-bottom>
        <div class="px-3 pb-3 pt-1">
          <UButton
            block
            color="neutral"
            variant="soft"
            icon="i-lucide-log-out"
            @click="handleLogout"
          >
            退出登录
          </UButton>
        </div>
      </template>
    </UDropdownMenu>

    <!-- 同步状态指示器：占据原来那个没用的 chevron 的位置，悬停弹出同步详情 -->
    <SyncStatusIndicator v-if="!collapsed" />
  </div>
</template>
