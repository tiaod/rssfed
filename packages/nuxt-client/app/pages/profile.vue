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

// 头像上传：选择文件后立即上传并刷新 session（S3 存储，URL 落 user.image）
const api = useApi()
const uploadingAvatar = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)
const handleAvatarChange = async (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingAvatar.value = true
  try {
    await api.user.uploadAvatar(file)
    await userStore.refresh()
    toast.add({ title: '头像已更新', color: 'success' })
  } catch (err: any) {
    toast.add({ title: '头像上传失败', description: String(err?.data?.error ?? err?.message ?? err), color: 'error' })
  } finally {
    uploadingAvatar.value = false
    input.value = ''
  }
}

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

// 重置本地缓存：清空本地 PouchDB 并全量重同步（双击确认防误触）
const pouch = usePouchDb()
const resetting = ref(false)
const confirmReset = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
const handleReset = async () => {
  if (resetting.value) return
  if (!confirmReset.value) {
    confirmReset.value = true
    confirmTimer = setTimeout(() => { confirmReset.value = false }, 4000)
    return
  }
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmReset.value = false
  resetting.value = true
  try {
    await pouch.resetLocalData()
    await pouch.syncNow()
    toast.add({ title: '本地缓存已重置，正在重新同步', color: 'success' })
  } catch (e: any) {
    toast.add({ title: '重置失败', description: String(e?.message ?? e), color: 'error' })
  } finally {
    resetting.value = false
  }
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
                  <UButton
                    size="xs"
                    variant="outline"
                    icon="i-lucide-camera"
                    :loading="uploadingAvatar"
                    @click="avatarInput?.click()"
                  >
                    更换头像
                  </UButton>
                  <input
                    ref="avatarInput"
                    type="file"
                    accept="image/*"
                    class="hidden"
                    @change="handleAvatarChange"
                  />
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

                <USeparator />

                <!-- 数据管理：低频操作，低调放置 -->
                <section class="space-y-2">
                  <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                    数据
                  </h3>
                  <div class="flex items-center justify-between gap-4">
                    <div class="min-w-0">
                      <p class="text-sm font-medium">
                        重置本地缓存
                      </p>
                      <p class="text-xs text-muted">
                        清空本地缓存的条目与图片并从服务器重新同步（不影响服务器数据）。本地数据异常（如图片/封面缺失）时使用。
                      </p>
                    </div>
                    <UButton
                      color="neutral"
                      variant="outline"
                      size="sm"
                      :icon="confirmReset ? 'i-lucide-triangle-alert' : 'i-lucide-rotate-ccw'"
                      :label="confirmReset ? '确认重置' : '重置'"
                      :loading="resetting"
                      @click="handleReset"
                    />
                  </div>
                </section>
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
