<script setup lang="ts">
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'
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

const tabs = [
  { label: '订阅管理', icon: 'i-lucide-rss' },
  { label: '通用', icon: 'i-lucide-settings' }
]
// 注意：UTabs 的 tab 值内部为字符串（String(index)），需用字符串初始值才能默认激活第一个 tab
const activeTab = ref('0')

// 条目详情模态宽度选项
const modalSizeOptions: { label: string, value: EntryModalSize }[] = [
  { label: '标准', value: 'sm:max-w-xl' },
  { label: '较宽', value: 'sm:max-w-2xl' },
  { label: '宽', value: 'sm:max-w-4xl' },
  { label: '很宽', value: 'sm:max-w-6xl' },
  { label: '全屏', value: 'fullscreen' },
]
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="设置" />
    </template>

    <template #body>
      <div class="w-full px-4 py-6 space-y-6">
        <UTabs
          v-model="activeTab"
          :items="tabs"
        >
          <template #content="{ index }">
            <!-- 订阅管理 -->
            <div
              v-if="index === 0"
              class="pt-4"
            >
              <SubscriptionManager />
            </div>

            <!-- 通用 -->
            <div
              v-else
              class="pt-6 space-y-8"
            >
              <!-- 账户 -->
              <section class="space-y-3">
                <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                  账户
                </h3>
                <div class="flex items-center gap-3">
                  <UAvatar
                    v-if="user?.image"
                    :src="user.image"
                    :alt="user?.name"
                    size="lg"
                  />
                  <UAvatar
                    v-else
                    :text="user?.name?.[0] || 'U'"
                    size="lg"
                    color="primary"
                  />
                  <div>
                    <p class="font-medium">
                      {{ user?.name || '用户' }}
                    </p>
                    <p class="text-sm text-muted">
                      {{ user?.email }}
                    </p>
                  </div>
                </div>
              </section>

              <USeparator />

              <!-- 阅读 -->
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

              <!-- 关于 -->
              <section class="space-y-3">
                <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                  关于
                </h3>
                <div class="flex items-center gap-2 text-sm">
                  <UIcon
                    name="i-lucide-wifi"
                    class="size-4"
                    :class="isOnline ? 'text-green-500' : 'text-red-500'"
                  />
                  <span>{{ isOnline ? '在线' : '离线' }}</span>
                </div>
              </section>

              <USeparator />

              <!-- 保存 -->
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
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
