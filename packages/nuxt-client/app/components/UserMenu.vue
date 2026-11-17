<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
// 显式导入：与 FeedNavigation 的 FeedIcon 一致，避免组件清单扫描不到时静默退化
import SyncStatusIndicator from '~/components/SyncStatusIndicator.vue'
// 显式导入：设置弹窗的状态在 composable 里（弹窗本体挂在布局上）
import { useSettingsModal } from '~/composables/useSettingsModal'

const userStore = useUserStore()
// 必须保持响应式：登录 / 登出 / 换账号后 session 会更新，快照取值不会跟着刷新
const user = computed(() => userStore.user)
const isAdmin = computed(() => userStore.isAdmin)
// 设置由弹窗承载（见 composables/useSettingsModal），菜单项不跳页
const { open: openSettings } = useSettingsModal()

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

const items = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = [
    [
      {
        label: '账户资料',
        icon: 'i-lucide-user',
        to: '/profile'
      },
      {
        label: '订阅管理',
        icon: 'i-lucide-rss',
        to: '/subscriptions'
      },
      {
        label: '设置',
        icon: 'i-lucide-settings',
        // 打开设置弹窗，不跳页：用户通常正读到一半，跳页会丢掉列表与滚动位置
        // （弹窗与入口不同组件树，状态见 composables/useSettingsModal）
        onSelect: () => { openSettings('general') }
      }
    ]
  ]
  // 管理员设置独立成页：只有管理员看得到这一项，普通用户不再看到灰色的管理标签
  if (isAdmin.value) {
    groups.push([
      {
        label: '管理后台',
        icon: 'i-lucide-shield',
        to: '/admin'
      }
    ])
  }
  groups.push(
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
  )
  return groups
})
</script>

<template>
  <!-- 未登录：首页等公开页面也能用 default 布局，此时直接给登录入口，不弹菜单 -->
  <UButton
    v-if="!user"
    to="/login"
    variant="ghost"
    :size="collapsed ? 'xs' : 'sm'"
    :class="collapsed ? 'w-full justify-center' : 'w-full justify-start'"
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
        :class="collapsed ? 'min-w-0 flex-1 justify-center' : 'min-w-0 flex-1 justify-start'"
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
