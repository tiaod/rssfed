<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'
import AdminFeedManager from '~/components/admin/AdminFeedManager.vue'
import SiteSettingsManager from '~/components/admin/SiteSettingsManager.vue'
import McpSetupPanel from '~/components/settings/McpSetupPanel.vue'
import { useStorageEstimate, formatBytes } from '~/composables/useStorageEstimate'
import type { AppSettings, EntryModalSize } from '~/composables/useSettings'
import { LIST_VIEW_OPTIONS, type ListView } from '~/utils/listViews'
import {
  TIMELINE_MIN_ENTRIES_CHOICES,
  TIMELINE_WINDOW_CHOICES,
  timelineSettingsEqual,
  withCurrentChoice
} from '~/utils/timelineSettings'

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

/**
 * 时间线聚合设置（服务端，每用户一份）。
 *
 * 与本地偏好一起由「保存设置」提交：两类设置都在同一张页面上，两个保存按钮反而更容易漏点。
 * 保存后服务端会催一次聚合（窗口调小剪枝、调大回填），数据随后由 live 复制到端。
 */
const {
  settings: timelineSettings, loaded: timelineLoaded, saving: timelineSaving,
  error: timelineError, load: loadTimelineSettings, save: saveTimelineSettings
} = useTimelineSettings()
const draftTimeline = ref({ ...timelineSettings.value })

// 服务端设置到达后同步草稿（进入页面时 load 是异步的）
watch(timelineSettings, (next) => {
  draftTimeline.value = { ...next }
})

onMounted(() => {
  void loadTimelineSettings()
})

const saving = ref(false)

const saveSettings = async () => {
  updateSettings({ ...draftSettings.value })
  // 本地偏好与时间线聚合设置一起保存：时间线设置没变就不发请求
  if (timelineLoaded.value && !timelineSettingsEqual(draftTimeline.value, timelineSettings.value)) {
    saving.value = true
    try {
      await saveTimelineSettings({ ...draftTimeline.value })
      toast.add({ title: '设置已保存', color: 'success' })
    } catch (e: unknown) {
      toast.add({ title: '时间线设置保存失败', description: errorMessage(e), color: 'error' })
    } finally {
      saving.value = false
    }
    return
  }
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

/**
 * 时间线聚合设置的窗口档位（值直接就是服务端字段的取值）。
 *
 * 经过 `withCurrentChoice`：服务端默认值可以调，档位表列不全所有可能取值，
 * 而「当前值不在 items 里」会让下拉显示空白（看起来像设置丢了）。
 */
const timelineWindowOptions = computed(() => withCurrentChoice(TIMELINE_WINDOW_CHOICES, draftTimeline.value.windowDays, '当前'))

/**
 * 「每个源至少保留多少条」的档位（同样经过 withCurrentChoice：服务端默认值可能被改过）。
 *
 * 它和窗口是**并集**关系，不是二选一：条目留下只要「在窗口内」**或**「是该源最新 N 条」之一成立。
 * 所以低频源不会因为窗口而整源空白，高频源也照旧按窗口收窄（窗口内的条数本来就超过 N）。
 */
const timelineMinEntriesOptions = computed(() => withCurrentChoice(TIMELINE_MIN_ENTRIES_CHOICES, draftTimeline.value.minFeedEntries, '当前'))

/**
 * 「默认列表视图」里的「跟随内置默认」项：选中它 = 不写设置（view 为 undefined）。
 *
 * 用一个哨兵字符串而不是空值：reka 的 Select 明确禁止选项值为空串（空串被它当作「清空选择」，
 * 传了整个下拉都打不开，见 EditSubscriptionModal 的同类注释）；undefined 又表示「未选中」，
 * 没法表达「显式选择：取消配置」这个动作。用户不选它时才落一个具体视图 —— 于是
 * 「没配过」与「配成瀑布流」区分得开，时间线的内置默认（社交动态）才生效。
 */
const INHERIT_VIEW = '__default__'

const viewOptions = [
  { label: '跟随内置默认', value: INHERIT_VIEW },
  ...LIST_VIEW_OPTIONS
]

const draftView = computed({
  get: () => draftSettings.value.view ?? INHERIT_VIEW,
  set: (value: string) => {
    draftSettings.value = {
      ...draftSettings.value,
      view: value === INHERIT_VIEW ? undefined : (value as ListView)
    }
  }
})

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
    // 清本地 → 重新拉：服务端派生库不动，重置后从头复制一遍（新库没有 checkpoint，
    // 必然是完整的首轮同步）
    await pouch.resetLocalData()
    await pouch.syncNow()
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
                    description="各列表页的默认视图；选「跟随内置默认」则不写配置 —— 时间线用「社交动态」，单个订阅源 / 分组 / 收藏页用「瀑布流」（列表页上的切换按钮只影响本次会话）"
                  >
                    <USelect
                      v-model="draftView"
                      :items="viewOptions"
                      value-key="value"
                      class="w-48"
                    />
                  </UFormField>

                  <UFormField
                    label="条目详情宽度"
                    description="详情弹窗的窗口宽度；宽屏的右侧阅读栏还用它限制正文宽度，阅读栏拖得再宽，多出来的也是两边留白"
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

                <section class="space-y-4">
                  <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
                    同步
                  </h3>

                  <!--
                    窗口与保底条数都由**服务端**在聚合时执行（每用户一份，见 useTimelineSettings）：
                    调小真的会删掉窗口外的派生数据（派生库是冗余副本，随时能从源库重算），
                    所以文案必须写明。图片参数不在这里：它是 per-feed 的，管理员在
                    「订阅源管理」里按源调，抓取时就压好了（见 AdminFeedManager）。
                  -->
                  <UFormField
                    label="时间线窗口"
                    :description="timelineLoaded
                      ? '只聚合这段时间内发布的条目；调大会把更早的条目补回来，调小会删掉窗口外的本地条目（源数据不受影响）。'
                      : '正在读取服务端设置…'"
                  >
                    <USelect
                      v-model="draftTimeline.windowDays"
                      :items="timelineWindowOptions"
                      value-key="value"
                      class="w-48"
                    />
                  </UFormField>

                  <!--
                    保底条数是窗口的**并集**（保留 = 窗口内 ∨ 该源最新 N 条），用户最容易误解成
                    "二选一"，文案写清楚；低频源（几天到几周才发一篇）就靠它不至于整源空白。
                  -->
                  <UFormField
                    label="每源保底条数"
                    :description="timelineLoaded
                      ? '每个订阅源至少保留最新的 N 条，即使它们已经超出上面的时间窗口 —— 更新很慢的源因此不会一条都没有。高频源不受影响（窗口内的条数本来就超过 N）。'
                      : '正在读取服务端设置…'"
                  >
                    <USelect
                      v-model="draftTimeline.minFeedEntries"
                      :items="timelineMinEntriesOptions"
                      value-key="value"
                      class="w-48"
                    />
                  </UFormField>

                  <UFormField
                    label="AI 摘要"
                    description="为每条内容生成摘要。开关已经可以设置，生成链路还在开发中，开启后暂时不会产出摘要。"
                  >
                    <USwitch v-model="draftTimeline.aiSummaryEnabled" />
                  </UFormField>

                  <p
                    v-if="timelineError"
                    class="text-sm text-error"
                  >
                    {{ timelineError }}
                  </p>
                </section>

                <USeparator />

                <div class="flex justify-start">
                  <UButton
                    color="primary"
                    icon="i-lucide-save"
                    :loading="saving || timelineSaving"
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
