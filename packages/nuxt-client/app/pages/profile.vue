<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'
import AdminFeedManager from '~/components/admin/AdminFeedManager.vue'
import SiteSettingsManager from '~/components/admin/SiteSettingsManager.vue'
import McpSetupPanel from '~/components/settings/McpSetupPanel.vue'
import { useStorageEstimate, formatBytes } from '~/composables/useStorageEstimate'
import type { AppSettings, EntryModalSize } from '~/composables/useSettings'
import { LIST_VIEW_OPTIONS } from '~/utils/listViews'

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
  } catch (err: unknown) {
    toast.add({ title: '头像上传失败', description: errorMessage(err), color: 'error' })
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
  { label: '全屏', value: 'fullscreen' }
]

const isAdmin = computed(() => userStore.isAdmin)

// 标签页：AI 助手对普通用户可用；管理员额外显示“订阅源管理”“站点设置”
const tabs = computed(() => {
  const items = [
    { label: '订阅管理', icon: 'i-lucide-rss' },
    { label: '通用设置', icon: 'i-lucide-settings' },
    { label: 'AI 助手', icon: 'i-lucide-bot' }
  ]
  if (isAdmin.value) {
    items.push({ label: '订阅源管理', icon: 'i-lucide-shield' })
    items.push({ label: '站点设置', icon: 'i-lucide-palette' })
  }
  return items
})
// 注意：UTabs 的 tab 值内部为字符串（String(index)），需用字符串初始值才能默认激活第一个 tab
// 与 URL 的 ?tab= 双向绑定：用户菜单里的「通用设置」直接落到对应标签页，手动切页也同步回地址栏
const route = useRoute()
const activeTab = computed({
  get: () => {
    const tab = route.query.tab
    // 越界或非数字（含管理员才有后两个标签页）一律回落到第一个标签页
    const valid = typeof tab === 'string' && /^\d+$/.test(tab) && Number(tab) < tabs.value.length
    return valid ? tab : '0'
  },
  set: (value: string) => {
    void navigateTo(
      { query: { ...route.query, tab: value === '0' ? undefined : value } },
      { replace: true }
    )
  }
})

const handleLogout = async () => {
  await userStore.logout()
  await navigateTo('/login')
}

/**
 * 重置本地缓存：清空本地 PouchDB 与全部增量水位，并从服务器全量重同步。
 *
 * 破坏性操作（本地条目、图片、已读/收藏的本地副本都会没），必须走弹窗确认：
 * 原先的「双击按钮」在触控板上极易误触，而且用户第二次点击时往往并不确定
 * 自己在确认什么。弹窗里把后果讲清楚，确认键用 error 色。
 */
const pouch = usePouchDb()
const resetting = ref(false)
/** 确认弹窗开关（用 ref 而非 computed：弹窗需要可被外部指令式打开） */
const resetOpen = ref(false)

/**
 * 本地存储占用：只有 StorageManager 能给出真实占用（PouchDB 的 db.info()
 * 只返回文档数，没有体积字段 —— 详见 useStorageEstimate 的说明）。
 *
 * 进入设置页时读一次；同步结束后再读一次 —— 刚拉完一批条目 / 图片时
 * 用量变化最明显，用户此时看设置页正是想知道「缓存到底占了多少」。
 */
const storageEstimate = useStorageEstimate()
onMounted(() => {
  void storageEstimate.refresh()
})
// 剩余目标从「有」变为「无」即为一轮同步结束
const remainingSyncTargets = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'syncing' || s.status === 'queued').length
)
watch(
  () => remainingSyncTargets.value,
  (current, previous) => {
    if (previous > 0 && current === 0) void storageEstimate.refresh()
  }
)

/** 弹窗内的失败原因（非空时在弹窗里显示，不关弹窗） */
const resetError = ref<string | null>(null)

/** 打开确认弹窗：顺手清掉上一次的错误，否则重开后还挂着旧报错 */
function openResetConfirm() {
  resetError.value = null
  resetOpen.value = true
}

/**
 * 确认弹窗里的「确认重置」：执行重置 + 全量重同步。
 *
 * 失败不关弹窗，把原因显示在弹窗里（同 SubscriptionManager 的取消订阅确认）——
 * 直接关掉再弹 toast，用户会以为重置成功了。
 */
const confirmReset = async () => {
  if (resetting.value) return
  resetting.value = true
  resetError.value = null
  try {
    await pouch.resetLocalData()
    // 重置后必须全量：本地库与 checkpoint 都已清空，且水位线已删，
    // 若走默认增量，服务器「从未抓到新条目」的源会被 needsSync 挡掉，本地永远补不回来
    await pouch.syncNow(undefined, { full: true })
    // 重置清空了本地库：立刻重算用量，让用户看到「缓存已清」而不是旧数字
    void storageEstimate.refresh()
    resetOpen.value = false
    toast.add({ title: '本地缓存已重置，正在重新同步', color: 'success' })
  } catch (e: unknown) {
    resetError.value = errorMessage(e)
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

        <!-- 功能标签页 -->
        <UTabs
          v-model="activeTab"
          :items="tabs"
        >
          <template #content="{ index }">
            <div class="pt-4">
              <!-- 订阅管理 -->
              <SubscriptionManager v-if="index === 0" />

              <!-- 通用设置 -->
              <div
                v-else-if="index === 1"
                class="space-y-8"
              >
                <section class="space-y-4">
                  <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                    阅读
                  </h3>

                  <UFormField
                    label="默认列表视图"
                    description="时间线用这个默认；单个订阅源 / 分组没有单独配置时也用它（列表页上的切换按钮只影响本次会话）"
                  >
                    <USelect
                      v-model="draftSettings.view"
                      :items="LIST_VIEW_OPTIONS"
                      value-key="value"
                      class="w-48"
                    />
                  </UFormField>

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

                <!-- 数据管理：低频操作，各自独立成卡片，说明与操作同处卡片正文、左对齐。
                     不用卡片底栏也不加分隔线：卡片边框已经把这一项圈成整体，
                     再切一条横线只会把「说明」和「操作」拆成两块。 -->
                <div
                  data-testid="data-section"
                  class="space-y-3"
                >
                  <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                    数据
                  </h3>

                  <!--
                    本地存储占用：数字来自 navigator.storage.estimate()，是**整个站点**
                    在本浏览器的占用（IndexedDB + SW 预缓存 + localStorage），
                    不是单个 PouchDB 库 —— 浏览器没有按库统计体积的接口，
                    所以文案必须说「本站缓存」而不是「条目库」。
                  -->
                  <UCard v-if="storageEstimate.supported.value">
                    <p class="text-sm font-medium">
                      本地存储占用
                    </p>
                    <p class="mt-1 text-xs text-muted">
                      <template v-if="storageEstimate.info.value">
                        本站已用 {{ formatBytes(storageEstimate.info.value.usage) }}<template
                          v-if="storageEstimate.info.value.quota"
                        >
                          ，浏览器配额 {{ formatBytes(storageEstimate.info.value.quota) }}（{{
                            Math.round((storageEstimate.info.value.ratio ?? 0) * 100)
                          }}%）
                        </template>。含离线条目、图片与页面缓存{{
                          storageEstimate.info.value.persisted === true
                            ? '；已获得持久化授权，不会被浏览器自动清理'
                            : storageEstimate.info.value.persisted === false
                              ? '；尚未获得持久化授权，磁盘紧张时浏览器可能清理'
                              : ''
                        }}
                      </template>
                      <template v-else>
                        正在读取…
                      </template>
                    </p>
                    <div class="mt-3">
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        icon="i-lucide-refresh-cw"
                        label="重新读取"
                        :loading="storageEstimate.loading.value"
                        @click="storageEstimate.refresh()"
                      />
                    </div>
                  </UCard>

                  <UCard>
                    <p class="text-sm font-medium">
                      重置本地缓存
                    </p>
                    <p class="mt-1 text-xs text-muted">
                      清空本地缓存的条目与图片并从服务器重新同步（不影响服务器数据）。本地数据异常（如图片/封面缺失）时使用。
                    </p>
                    <div class="mt-3">
                      <!-- 破坏性操作：error 色 + 三角警告图标。真正执行前还要过弹窗确认，
                           按钮本身不承担「防误触」职责（那会让第二次点击语义模糊） -->
                      <UButton
                        color="error"
                        variant="outline"
                        size="sm"
                        icon="i-lucide-triangle-alert"
                        label="重置"
                        @click="openResetConfirm"
                      />
                    </div>
                  </UCard>
                </div>
              </div>

              <!-- AI 助手（MCP 接入） -->
              <McpSetupPanel v-else-if="index === 2" />

              <!-- 订阅源管理（管理员） -->
              <AdminFeedManager v-else-if="isAdmin && index === 3" />

              <!-- 站点设置（管理员） -->
              <SiteSettingsManager v-else-if="isAdmin && index === 4" />
            </div>
          </template>
        </UTabs>
      </div>

      <!-- 重置本地缓存的确认弹窗：破坏性操作一律二次确认，并把后果写在正文里 -->
      <UModal
        v-model:open="resetOpen"
        title="重置本地缓存？"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <div class="space-y-3">
            <UAlert
              color="error"
              variant="soft"
              icon="i-lucide-triangle-alert"
              title="这会清空本机上已下载的内容"
            >
              <template #description>
                <ul class="list-disc pl-4 space-y-1 text-sm">
                  <li>本地缓存的条目、图片与封面全部删除</li>
                  <li>本地的已读 / 收藏标记与同步记录一并清空</li>
                  <li>服务器上的数据不受影响，随后会重新全量同步</li>
                  <li>重新下载全部缓存需要一些时间，期间请保持页面打开</li>
                </ul>
              </template>
            </UAlert>
            <UAlert
              v-if="resetError"
              color="error"
              variant="soft"
              icon="i-lucide-circle-alert"
              :title="resetError"
            />
          </div>
        </template>
        <template #footer="{ close }">
          <UButton
            variant="outline"
            color="neutral"
            :disabled="resetting"
            @click="close"
          >
            取消
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-rotate-ccw"
            :loading="resetting"
            @click="confirmReset"
          >
            确认重置
          </UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
