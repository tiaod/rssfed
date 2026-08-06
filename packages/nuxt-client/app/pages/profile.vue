<script setup lang="ts">
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'
import AdminFeedManager from '~/components/admin/AdminFeedManager.vue'
import type { AppSettings, EntryModalSize } from '~/composables/useSettings'

definePageMeta({
  layout: 'default'
})

const userStore = useUserStore()
const user = userStore.user
const { isOnline } = useOffline()
const { settings, updateSettings } = useSettings()
const toast = useToast()

// 设置草稿：修改后需点击“保存”按钮才生效并持久化
const draftSettings = ref<AppSettings>({ ...settings.value })

const saveSettings = () => {
  updateSettings({ ...draftSettings.value })
  toast.add({ title: '设置已保存', color: 'success' })
}

// 条目详情模态宽度选项
const modalSizeOptions: { label: string, value: EntryModalSize }[] = [
  { label: '标准', value: 'sm:max-w-xl' },
  { label: '较宽', value: 'sm:max-w-2xl' },
  { label: '宽', value: 'sm:max-w-4xl' },
  { label: '很宽', value: 'sm:max-w-6xl' },
  { label: '全屏', value: 'fullscreen' },
]

const isAdmin = computed(() => userStore.isAdmin)

// 标签页：管理员额外显示“订阅源管理”
const tabs = computed(() => {
  const items = [
    { label: '订阅管理', icon: 'i-lucide-rss' },
    { label: '通用设置', icon: 'i-lucide-settings' },
  ]
  if (isAdmin.value) {
    items.push({ label: '订阅源管理', icon: 'i-lucide-shield' })
  }
  return items
})
// 注意：UTabs 的 tab 值内部为字符串（String(index)），需用字符串初始值才能默认激活第一个 tab
const activeTab = ref('0')

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/login')
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="我的" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl px-4 py-6 space-y-6">
        <!-- 账户概览 -->
        <UCard>
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-4">
              <UAvatar
                v-if="user?.image"
                :src="user.image"
                :alt="user.name"
                size="xl"
              />
              <UAvatar
                v-else
                :text="user?.name?.[0] || 'U'"
                size="xl"
                color="primary"
              />
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="text-lg font-bold truncate">{{ user?.name || '用户' }}</h2>
                  <UBadge
                    v-if="isAdmin"
                    color="primary"
                    variant="subtle"
                    size="xs"
                  >
                    <template #leading>
                      <UIcon name="i-lucide-shield" class="size-3" />
                    </template>
                    管理员
                  </UBadge>
                </div>
                <p class="text-sm text-muted truncate">{{ user?.email }}</p>
                <div class="mt-1 flex items-center gap-2 text-sm">
                  <UIcon
                    name="i-lucide-wifi"
                    class="size-4"
                    :class="isOnline ? 'text-green-500' : 'text-red-500'"
                  />
                  <span>{{ isOnline ? '在线' : '离线' }}</span>
                </div>
              </div>
            </div>

            <UButton
              color="error"
              variant="outline"
              icon="i-lucide-log-out"
              @click="handleLogout"
            >
              退出登录
            </UButton>
          </div>
        </UCard>

        <!-- 功能标签页 -->
        <UTabs v-model="activeTab" :items="tabs">
          <template #content="{ index }">
            <div class="pt-4">
              <!-- 订阅管理 -->
              <SubscriptionManager v-if="index === 0" />

              <!-- 通用设置 -->
              <div v-else-if="index === 1" class="space-y-8">
                <section class="space-y-4">
                  <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                    阅读
                  </h3>
                  <UFormField
                    label="条目详情宽度"
                    description="控制点击条目时弹出的详情窗口宽度"
                  >
                    <USelect
                      v-model="draftSettings.entryModalSize"
                      :items="modalSizeOptions"
                      value-key="value"
                      class="w-48"
                    />
                  </UFormField>

                  <UFormField
                    label="固定顶部栏和底部栏"
                    description="全屏时固定顶栏与底栏、仅正文滚动；关闭后随文章一起滚动"
                  >
                    <USwitch v-model="draftSettings.fixedBars" />
                  </UFormField>
                </section>

                <USeparator />

                <div class="flex justify-start">
                  <UButton
                    color="primary"
                    icon="i-lucide-save"
                    @click="saveSettings"
                  >
                    保存设置
                  </UButton>
                </div>
              </div>

              <!-- 订阅源管理（管理员） -->
              <AdminFeedManager v-else-if="isAdmin && index === 2" />
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
