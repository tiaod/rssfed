<script setup lang="ts">
import { computed, ref } from 'vue'
import { useOffline } from '~/composables/useOffline'
import { useSettingsModal } from '~/composables/useSettingsModal'

definePageMeta({
  layout: 'default'
})

/**
 * 账户资料页。
 *
 * 只放「我是谁、我这个账号怎么登出」这类账号级信息。其它三块在 2026-11 拆走：
 *  - 阅读 / 同步 / AI / 数据偏好 → 设置弹窗（components/settings/SettingsModal.vue）；
 *  - 订阅管理 → `/subscriptions` 独立页（列表长、需要整页空间）；
 *  - 订阅源与站点配置 → `/admin` 独立页（只有管理员看得到）。
 *
 * 拆分的动机：原先这三类东西挤在一排标签页里，普通用户能看到两个永远用不上的管理员标签，
 * 而打开「设置」却要先离开正在读的列表、跳到这一页。
 */
const userStore = useUserStore()
const user = userStore.user
const { isOnline } = useOffline()
const { open: openSettings } = useSettingsModal()
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
  } catch (err: unknown) {
    toast.add({ title: '头像上传失败', description: errorMessage(err), color: 'error' })
  } finally {
    uploadingAvatar.value = false
    input.value = ''
  }
}

const isAdmin = computed(() => userStore.isAdmin)

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/login')
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="账户资料">
        <template #right>
          <!--
            这三个入口在手机上只留图标：顶栏在 lg 以下是 3rem、还要塞下开合按钮 + 标题，
            三个带文字的按钮会把「账户资料」挤成「账户」（标题 slot 是 truncate）。
            图标语义明确（RSS / 盾牌 / 齿轮），配 aria-label 不至于失去可访问名。
          -->
          <UButton
            to="/subscriptions"
            icon="i-lucide-rss"
            color="neutral"
            variant="ghost"
            size="sm"
            label="订阅管理"
            aria-label="订阅管理"
            :ui="{ label: 'hidden lg:inline' }"
          />
          <UButton
            v-if="isAdmin"
            to="/admin"
            icon="i-lucide-shield"
            color="neutral"
            variant="ghost"
            size="sm"
            label="管理后台"
            aria-label="管理后台"
            :ui="{ label: 'hidden lg:inline' }"
          />
          <UButton
            icon="i-lucide-settings"
            color="neutral"
            variant="ghost"
            size="sm"
            label="设置"
            aria-label="设置"
            :ui="{ label: 'hidden lg:inline' }"
            @click="openSettings()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
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
                  <h2 class="text-lg font-bold truncate">
                    {{ user?.name || '用户' }}
                  </h2>
                  <UBadge
                    v-if="isAdmin"
                    color="primary"
                    variant="subtle"
                    size="xs"
                  >
                    <template #leading>
                      <UIcon
                        name="i-lucide-shield"
                        class="size-3"
                      />
                    </template>
                    管理员
                  </UBadge>
                </div>
                <p class="text-sm text-muted truncate">
                  {{ user?.email }}
                </p>
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
                  >
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

        <!-- 入口卡：设置与订阅管理不再是这一页的标签页，留一张卡交代它们去哪了 -->
        <div class="grid gap-3 sm:grid-cols-2">
          <UCard
            class="cursor-pointer transition-colors hover:ring-primary/40"
            @click="openSettings()"
          >
            <div class="flex items-start gap-3">
              <UIcon
                name="i-lucide-settings"
                class="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  设置
                </p>
                <p class="mt-1 text-xs text-muted">
                  阅读偏好、正文字体与字号、AI 摘要、本地缓存与同步日志。
                </p>
              </div>
            </div>
          </UCard>

          <UCard
            class="cursor-pointer transition-colors hover:ring-primary/40"
            @click="navigateTo('/subscriptions')"
          >
            <div class="flex items-start gap-3">
              <UIcon
                name="i-lucide-rss"
                class="mt-0.5 size-5 shrink-0 text-primary"
              />
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  订阅管理
                </p>
                <p class="mt-1 text-xs text-muted">
                  搜索订阅、整理分组、批量导入导出（OPML）。
                </p>
              </div>
            </div>
          </UCard>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
