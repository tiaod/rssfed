<script setup lang="ts">
/**
 * 设置弹窗 →「数据」分区：本地缓存占用、清理、重置与同步日志。
 *
 * 从原「我的 → 通用设置 → 数据」整块搬过来的：这些是低频、偏运维的动作，
 * 与阅读偏好分开一块，避免在「常规」里一路滑到底才能找到「重置缓存」。
 *
 * 挂载时机跟随弹窗：弹窗关掉时整个分区卸载，所以「进入设置读一次用量」自然变成了
 * 「每次打开设置读一次」—— 这正是想要的（用完即弃的读数，没必要一直挂着监听）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useStorageEstimate, formatBytes } from '~/composables/useStorageEstimate'
import { useLocalDbCleanup } from '~/composables/useLocalDbCleanup'
import { useSettingsModal } from '~/composables/useSettingsModal'
import {
  formatSince,
  formatTimelineEventData,
  formatTimelineEventTime,
  summarizeTimelineSources,
  timelineEventColor,
  timelineEventLabel
} from '~/utils/timelineLog'
import {
  backgroundSyncEventColor,
  backgroundSyncEventLabel,
  formatBackgroundSyncData,
  formatBackgroundSyncTime
} from '~/utils/backgroundSyncLogFormat'

const userStore = useUserStore()
const toast = useToast()
const pouch = usePouchDb()
const { consumeTimelineLogIntent } = useSettingsModal()

/**
 * 本地存储占用：只有 StorageManager 能给出真实占用（PouchDB 的 db.info()
 * 只返回文档数，没有体积字段 —— 详见 useStorageEstimate 的说明）。
 */
const storageEstimate = useStorageEstimate()

// 剩余目标从「有」变为「无」即为一轮同步结束
const remainingSyncTargets = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'syncing' || s.status === 'queued').length
)
watch(
  () => remainingSyncTargets.value,
  (current, previous) => {
    // 刚拉完一批条目 / 图片时用量变化最明显，用户此时正想知道「缓存到底占了多少」
    if (previous > 0 && current === 0) void storageEstimate.refresh()
  }
)

/**
 * 重置本地缓存：清空本地 PouchDB 与全部增量水位，并从服务器全量重同步。
 *
 * 破坏性操作（本地条目、图片、已读/收藏的本地副本都会没），必须走弹窗确认：
 * 原先的「双击按钮」在触控板上极易误触，而且用户第二次点击时往往并不确定
 * 自己在确认什么。弹窗里把后果讲清楚，确认键用 error 色。
 */
const resetting = ref(false)
const resetOpen = ref(false)
const resetError = ref<string | null>(null)

function openResetConfirm() {
  resetError.value = null
  resetOpen.value = true
}

/**
 * 确认重置：执行重置 + 全量重同步。
 *
 * 失败不关弹窗，把原因显示在弹窗里（同 SubscriptionManager 的取消订阅确认）——
 * 直接关掉再弹 toast，用户会以为重置成功了。
 */
const confirmReset = async () => {
  if (resetting.value) return
  resetting.value = true
  resetError.value = null
  try {
    // 清本地 → 重新拉：服务端的用户库不动，重置后从头复制一遍（新库没有 checkpoint，
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

/**
 * 其它账号的本地缓存清理。
 *
 * 本地库按账号隔离且「换回来还能离线读」（见 utils/localDbName），所以每登录过一个账号
 * 这个浏览器就多留一份整库副本。这里只负责扫描/清理的状态，名字判断与 IndexedDB 操作在
 * useLocalDbCleanup / utils/localDbCleanup。
 *
 * 销毁的是**别的账号**的离线副本：当前账号与服务器数据都不动；被清的账号下次登录会
 * 整库重新同步（这正是删它的代价，弹窗里写清楚）。
 */
const localDbCleanup = useLocalDbCleanup()
const cleanupOpen = ref(false)
const cleanupError = ref<string | null>(null)

function openCleanupConfirm() {
  cleanupError.value = null
  cleanupOpen.value = true
}

/**
 * 会话是异步恢复的：user id 一到就扫一遍（immediate 覆盖「打开设置时会话已就绪」）。
 * 每次重扫都只挑「别的账号」的库 —— 当前账号的库永远不在名单里。
 */
watch(
  () => userStore.user?.id ?? null,
  (id) => {
    // 会话就绪前 user id 是 null：这时候扫描会把「当前账号的库」当成「其它账号」列出来，
    // 点下去就删了自己的离线数据。因此拿不到账号时先不扫，等会话恢复再看。
    if (id) void localDbCleanup.scan(id)
  },
  { immediate: true }
)

/**
 * 确认清理：删完重新扫（被别的标签页占住的库会原样留着），并立刻重算整站占用，
 * 让用户在上方那张卡里看到数字回落。
 */
const confirmCleanup = async () => {
  if (localDbCleanup.cleaning.value) return
  const userId = userStore.user?.id
  if (!userId) return
  cleanupError.value = null
  const result = await localDbCleanup.clean(userId)
  void storageEstimate.refresh()
  if (result.deleted > 0) {
    toast.add({ title: `已清理 ${result.accounts} 个账号的本地缓存`, color: 'success' })
  }
  if (result.failed > 0) {
    cleanupError.value = localDbCleanup.error.value ?? `${result.failed} 个本地库未能删除`
    return
  }
  cleanupOpen.value = false
}

/**
 * 同步日志（调试用，折叠在这里）。
 *
 * 服务端抓取的过程用户平时看不见（只在服务端控制台），排查"时间线怎么不动了"时用它：
 * 每一轮抓取什么时候跑的、订阅多少源、几个到期、新增/裁剪了多少条、哪些轮次失败了。
 * 不在挂载时就请求 —— 展开时才拉，避免把一个调试面板变成每次打开设置都多打一个接口。
 *
 * 每个源**当前**的抓取状态（上次抓到什么时候、还有没有失败）来自另一处：
 * 新模型下它写在用户库的 `_local/schedule`，由订阅列表接口读出来（就是面板底部那份
 * 「各源状态」）。服务端流水只回答「历史上每一轮都干了什么」，而且晚一轮才出现。
 */
const {
  events: timelineEvents, sources: timelineSources, heartbeat: timelineHeartbeat,
  loaded: timelineLogLoaded, loading: timelineLogLoading, clearing: timelineLogClearing,
  error: timelineLogError, canLoadMore: timelineLogCanLoadMore,
  load: loadTimelineLog, loadMore: loadMoreTimelineLog, clear: clearTimelineLog
} = useTimelineLog()
const timelineSourceSummary = computed(() => summarizeTimelineSources(timelineSources.value))
const timelineLogOpen = ref(false)

/**
 * 后台同步日志（本机 IndexedDB，见 utils/backgroundSyncLog）。
 *
 * 与上面那份服务端日志分开成两块面板：一份说「服务端做了什么」，一份说「浏览器做了
 * 什么」。排查「后台同步没触发」时前者永远是安静的 —— 因为那一轮抓取根本没被催到。
 */
const {
  events: backgroundSyncEvents,
  summary: backgroundSyncSummary,
  loading: backgroundSyncLoading,
  clearing: backgroundSyncClearing,
  load: loadBackgroundSyncLog,
  clear: clearBackgroundSyncLog
} = useBackgroundSyncLog()
const backgroundSyncOpen = ref(false)

async function openBackgroundSyncLog(): Promise<void> {
  backgroundSyncOpen.value = true
  await loadBackgroundSyncLog()
}

/** 展开并（首次）拉取；已展开时再点是「刷新」 */
async function openTimelineLog(): Promise<void> {
  timelineLogOpen.value = true
  if (!timelineLogLoaded.value) await loadTimelineLog()
}

onMounted(() => {
  void storageEstimate.refresh()
  // 时间线侧栏的「查看同步日志」：打开设置时直接落到这块面板上
  if (consumeTimelineLogIntent()) void openTimelineLog()
})
</script>

<template>
  <div
    data-testid="data-section"
    class="space-y-3"
  >
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

    <!--
      其它账号的本地缓存：本地库按账号隔离且「换回来还能离线读」，所以每个登录过的
      账号各留一份整库副本。这里只报「检测到几个账号」——浏览器没有按库统计体积的
      接口（见上面占用卡的说明），清理后让用户看「本地存储占用」的回落。
    -->
    <UCard v-if="localDbCleanup.supported.value">
      <p class="text-sm font-medium">
        其它账号的本地缓存
      </p>
      <p class="mt-1 text-xs text-muted">
        <template v-if="localDbCleanup.scanning.value">
          正在检查本机的离线副本…
        </template>
        <template v-else-if="localDbCleanup.accountCount.value > 0">
          检测到 {{ localDbCleanup.accountCount.value }} 个其它账号的离线副本。本浏览器会为每个登录过的账号各保留一份，清理后这些账号下次登录需要重新同步；当前账号的缓存与服务器数据不受影响。
        </template>
        <template v-else>
          没有其它账号的离线副本。
        </template>
      </p>
      <div class="mt-3 flex items-center gap-2">
        <UButton
          v-if="localDbCleanup.canClean.value"
          color="error"
          variant="outline"
          size="sm"
          icon="i-lucide-trash-2"
          label="清理"
          :disabled="localDbCleanup.cleaning.value"
          @click="openCleanupConfirm"
        />
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-refresh-cw"
          label="重新检测"
          :loading="localDbCleanup.scanning.value"
          @click="localDbCleanup.scan(userStore.user?.id ?? null)"
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
             按钮本身不承担「防误触」职责（那会让第二次点击含义模糊） -->
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

    <!--
      同步日志：服务端每一轮抓取干了什么（订阅几个源、几个到期、新增/裁剪/失败）用户看不到，
      折叠在这里当调试面板。默认折叠、展开才拉：设置弹窗是低频入口，不该每次打开都多打一个接口。
    -->
    <UCard>
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-medium">
            同步日志
          </p>
          <p class="mt-1 text-xs text-muted">
            服务端抓取的过程记录：每一轮什么时候跑的、订阅多少源、几个到期、新增与裁剪了多少条、哪几个源失败了。抓取按调度间隔（默认 15 分钟）跑，空转轮次也会记一条（用来确认抓取确实在跑），只保留最近 2000 条。下面「各源状态」是现在的实际情况（读你自己库里的调度状态），上面的流水则是历史。
          </p>
        </div>
        <UButton
          v-if="!timelineLogOpen"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-scroll-text"
          label="查看"
          @click="openTimelineLog"
        />
      </div>

      <div
        v-if="timelineLogOpen"
        class="mt-3 space-y-3"
      >
        <!-- 概览：抓取心跳 / 最近一次抓到东西 / 连续空转 -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span v-if="timelineHeartbeat">
            最近一轮抓取 {{ formatSince(timelineHeartbeat.at) }}<template v-if="timelineHeartbeat.quietRounds > 0">（连续 {{ timelineHeartbeat.quietRounds }} 轮无新增）</template>
          </span>
          <span v-else>还没有跑过任何一轮抓取</span>
          <span v-if="timelineEvents.length > 0">最近记录 {{ formatSince(timelineEvents[0]!.at) }}</span>
        </div>

        <div class="flex flex-wrap gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-refresh-cw"
            label="刷新"
            :loading="timelineLogLoading"
            @click="loadTimelineLog"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-eraser"
            label="清空"
            :loading="timelineLogClearing"
            @click="clearTimelineLog"
          />
        </div>

        <p
          v-if="timelineLogError"
          class="text-xs text-error"
        >
          {{ timelineLogError }}
        </p>

        <p
          v-if="timelineEvents.length === 0 && !timelineLogLoading"
          class="text-xs text-muted"
        >
          还没有记录。没有订阅时不会有抓取轮次；有订阅的话，下一轮调度（默认 15 分钟一次）跑完就会留下一条 —— 空转轮次也会记。
        </p>

        <ul
          v-else
          class="max-h-80 space-y-1.5 overflow-y-auto pr-1"
        >
          <li
            v-for="event in timelineEvents"
            :key="event.id"
            class="flex items-start gap-2 text-xs"
          >
            <span class="shrink-0 font-mono text-muted tabular-nums">
              {{ formatTimelineEventTime(event.at) }}
            </span>
            <UBadge
              :color="timelineEventColor(event.kind, event.level)"
              variant="subtle"
              size="xs"
              class="shrink-0"
            >
              {{ timelineEventLabel(event.kind) }}
            </UBadge>
            <span class="min-w-0 break-words">
              {{ event.message }}
              <span
                v-if="formatTimelineEventData(event.data)"
                class="text-muted"
              >· {{ formatTimelineEventData(event.data) }}</span>
            </span>
          </li>
        </ul>

        <UButton
          v-if="timelineLogCanLoadMore"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-chevrons-down"
          label="加载更多"
          :loading="timelineLogLoading"
          @click="loadMoreTimelineLog"
        />

        <!--
          源级状态：这是「现在什么样」，不是流水。
          不在服务端流水里 —— 它随抓取写在用户自己的库（`_local/schedule`），
          由订阅列表接口读出来。所以刷新面板会顺带重读它。
        -->
        <details class="text-xs">
          <summary class="cursor-pointer text-muted">
            各源状态（{{ timelineSourceSummary.total }} 个<template v-if="timelineSourceSummary.errors > 0">
              ，{{ timelineSourceSummary.errors }} 个失败
            </template>）
          </summary>
          <p
            v-if="timelineSourceSummary.total === 0"
            class="mt-2 text-muted"
          >
            还没有订阅，或者订阅列表暂时读不到。
          </p>
          <ul
            v-else
            class="mt-2 max-h-60 space-y-1 overflow-y-auto pr-1"
          >
            <li
              v-for="source in timelineSources"
              :key="source.feedId"
              class="flex items-center justify-between gap-2"
            >
              <span class="min-w-0 truncate">{{ source.title || source.feedId }}</span>
              <span
                class="shrink-0 font-mono text-muted"
                :class="source.status === 'error' ? 'text-error' : ''"
                :title="source.errorMessage ?? ''"
              >
                {{ source.lastFetchedAt ? formatTimelineEventTime(source.lastFetchedAt) : '未抓取' }} · {{ source.status }}
              </span>
            </li>
          </ul>
        </details>
      </div>
    </UCard>

    <!--
      后台同步：数据源与本机 IndexedDB 里的日志一致，但记的是「浏览器到底有没有在后台
      唤醒 SW」—— 页面关着时也会写。它是回答「我的后台同步触发了吗」的唯一入口。
      同样默认折叠：登记与触发都在后台发生，没有主动查看的必要。
    -->
    <UCard>
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-medium">
            后台同步
          </p>
          <p class="mt-1 text-xs text-muted">
            断网时页面会登记一次后台同步，浏览器恢复联网后在后台唤醒 Service Worker 催服务端抓取（即使页面关着）。这里记的是本机发生的事：有没有登记成功、浏览器有没有真的触发、那一次请求的结果。只有 Chromium 系支持，Safari/iOS 与 Firefox 不会触发。
          </p>
        </div>
        <UButton
          v-if="!backgroundSyncOpen"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-radio-tower"
          label="查看"
          @click="openBackgroundSyncLog"
        />
      </div>

      <div
        v-if="backgroundSyncOpen"
        class="mt-3 space-y-3"
      >
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span v-if="backgroundSyncSummary.supported === false">本浏览器不支持 Background Sync</span>
          <span v-else-if="backgroundSyncSummary.supported === true">浏览器支持</span>
          <span v-else>还没登记过</span>
          <span>成功 {{ backgroundSyncSummary.ok }} 次</span>
          <span
            v-if="backgroundSyncSummary.failed > 0"
            class="text-error"
          >失败 {{ backgroundSyncSummary.failed }} 次</span>
          <span>最近成功 {{ formatSince(backgroundSyncSummary.lastOkAt) }}</span>
        </div>

        <div class="flex flex-wrap gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-refresh-cw"
            label="刷新"
            :loading="backgroundSyncLoading"
            @click="loadBackgroundSyncLog"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-eraser"
            label="清空"
            :loading="backgroundSyncClearing"
            @click="clearBackgroundSyncLog"
          />
        </div>

        <p
          v-if="backgroundSyncEvents.length === 0 && !backgroundSyncLoading"
          class="text-xs text-muted"
        >
          还没有记录。断网一次、再恢复联网，浏览器触发后台同步后这里就会出现记录。
        </p>

        <ul
          v-else
          class="max-h-60 space-y-1.5 overflow-y-auto pr-1"
        >
          <li
            v-for="event in backgroundSyncEvents"
            :key="event.id"
            class="flex items-start gap-2 text-xs"
          >
            <span class="shrink-0 font-mono text-muted tabular-nums">
              {{ formatBackgroundSyncTime(event.at) }}
            </span>
            <UBadge
              :color="backgroundSyncEventColor(event.kind)"
              variant="subtle"
              size="xs"
              class="shrink-0"
            >
              {{ backgroundSyncEventLabel(event.kind) }}
            </UBadge>
            <span class="min-w-0 break-words">
              {{ event.message }}
              <span
                v-if="formatBackgroundSyncData(event.data)"
                class="text-muted"
              >· {{ formatBackgroundSyncData(event.data) }}</span>
            </span>
          </li>
        </ul>
      </div>
    </UCard>

    <!-- 清理其它账号本地缓存的确认弹窗：删的是其它账号的整库副本，当前账号不受影响 -->
    <UModal
      v-model:open="cleanupOpen"
      title="清理其它账号的本地缓存？"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="space-y-3">
          <UAlert
            color="warning"
            variant="soft"
            icon="i-lucide-triangle-alert"
            title="会删除本机上其它账号的离线副本"
          >
            <template #description>
              <ul class="list-disc pl-4 space-y-1 text-sm">
                <li>{{ localDbCleanup.accountCount.value }} 个其它账号在本机缓存的条目、图片与状态会被删除</li>
                <li>这些账号下次登录会重新全量同步，首次打开会慢一些</li>
                <li>当前账号的缓存与服务器上的数据都不受影响</li>
              </ul>
            </template>
          </UAlert>
          <UAlert
            v-if="cleanupError"
            color="error"
            variant="soft"
            icon="i-lucide-circle-alert"
            :title="cleanupError"
          />
        </div>
      </template>
      <template #footer="{ close }">
        <UButton
          variant="outline"
          color="neutral"
          :disabled="localDbCleanup.cleaning.value"
          @click="close"
        >
          取消
        </UButton>
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          :loading="localDbCleanup.cleaning.value"
          @click="confirmCleanup"
        >
          确认清理
        </UButton>
      </template>
    </UModal>

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
  </div>
</template>
