<script setup lang="ts">
/**
 * 同步状态指示器：侧边栏左下角用户菜单右侧的图标按钮（原先是那个没用的 chevron）。
 *
 * 交互：**点击永远只是打开弹层**，不再「同步中点一下就暂停」——
 * 暂停 / 继续 / 立即同步 / 重置本地缓存全部是弹层里的显式按钮。
 *
 * 为什么要改：移动端没有悬停，图标既是「看详情」的入口又是「暂停同步」的触发器，
 * 手指一点就暂停整个同步很容易误触；把动作收进弹层后，鼠标和手指的行为完全一致，
 * 顶多隔一层点击，却不会误伤。
 *
 * 弹层内容：状态标题 + 本轮进度明细 + 云端/本地体积 + 一个动作按钮。
 * 状态判定与文案在 utils/syncStatusSummary 里（纯函数，便于单测）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'
import { useManualSync } from '~/composables/useManualSync'
import { useTimelineCloudInfo } from '~/composables/useTimelineCloudInfo'
import { formatBytes, useStorageEstimate } from '~/composables/useStorageEstimate'
import { summarizeSyncStatuses, syncStatusLabel, syncStatusDetails } from '~/utils/syncStatusSummary'
import type { SyncState } from '~/utils/syncStatusSummary'

const pouch = usePouchDb()
const summary = computed(() => summarizeSyncStatuses(pouch.syncStatuses, {
  paused: pouch.paused.value,
  storageError: pouch.storageBroken.value
}))
const label = computed(() => syncStatusLabel(summary.value.state))
const details = computed(() => syncStatusDetails(summary.value))

/**
 * 体积信息：云端库用 CouchDB 的 `GET /{db}`，本地用 StorageManager.estimate()。
 *
 * 两个数字口径不同，展示时都不能含糊（见 useTimelineCloudInfo / useStorageEstimate 头注释）：
 * 云端报外部字节（external，近似一次全量同步要过的量），本地只能报「整个站点」。
 */
const cloudInfo = useTimelineCloudInfo()
const storageEstimate = useStorageEstimate()

/** 云端库体积：`云端库 797.3 MB · 4965 条`（拿不到体积时只说条数） */
const cloudLine = computed(() => {
  const info = cloudInfo.info.value
  if (!info) return ''
  const size = info.externalSize !== null ? formatBytes(info.externalSize) : ''
  return size ? `云端库 ${size} · ${info.docCount} 条` : `云端库 ${info.docCount} 条`
})

/** 本地占用：浏览器拿不到「某个 PouchDB 库」的体积，这里是整个站点的缓存用量 */
const localLine = computed(() => {
  if (!storageEstimate.supported.value || !storageEstimate.info.value) return ''
  return `本站缓存 ${formatBytes(storageEstimate.info.value.usage)}`
})

onMounted(() => {
  void cloudInfo.refresh()
  void storageEstimate.refresh()
})

/** 弹层打开时刷新：体积变化慢，refresh 内部有缓存，不会每次打开都打请求 */
function refreshSizes() {
  void cloudInfo.refresh()
  void storageEstimate.refresh()
}

// 一轮同步结束后体积可能刚变大（服务端聚合进来新条目、本地也多了一份）：
// 顺手强刷一次，免得用户看到的是同步前的旧数字（refresh 的缓存默认 60 秒）
watch(() => summary.value.lastSyncedAt, (next, prev) => {
  if (!next || next === prev) return
  void cloudInfo.refresh(true)
  void storageEstimate.refresh()
})

/** 弹层开关（真源）：动作执行后主动关掉，让用户立刻看到 toast / 顶部进度条 */
const open = ref(false)

// 打开时读一次体积：原先挂在悬停上，悬停预览去掉后改挂在这里
watch(open, (isOpen) => {
  if (isOpen) refreshSizes()
})

// 动作触发手动同步：与顶部工具栏的同步按钮共用逻辑，结果会有 toast 反馈。
const { sync } = useManualSync()
const toast = useToast()

const ICONS: Record<SyncState, string> = {
  'syncing': 'i-lucide-refresh-cw',
  'paused': 'i-lucide-circle-pause',
  'error': 'i-lucide-alert-circle',
  'success': 'i-lucide-circle-check',
  'idle': 'i-lucide-cloud',
  'storage-error': 'i-lucide-alert-triangle'
}

const COLORS: Record<SyncState, string> = {
  'syncing': 'text-primary',
  'paused': 'text-warning',
  'error': 'text-error',
  'success': 'text-success',
  'idle': 'text-muted',
  'storage-error': 'text-error'
}

/** 弹层里那个按钮做什么：同步中→暂停，已暂停→继续，本地存储故障→重置本地缓存，其余→立即同步 */
const actionLabel = computed(() => {
  if (summary.value.state === 'syncing') return '暂停同步'
  if (summary.value.state === 'paused') return '继续同步'
  if (summary.value.state === 'storage-error') return '重置本地缓存'
  return '立即同步'
})

const ACTION_ICONS: Record<SyncState, string> = {
  'syncing': 'i-lucide-circle-pause',
  'paused': 'i-lucide-play',
  'error': 'i-lucide-refresh-cw',
  'success': 'i-lucide-refresh-cw',
  'idle': 'i-lucide-refresh-cw',
  'storage-error': 'i-lucide-rotate-ccw'
}

/**
 * 弹层里动作按钮的配色：暂停/立即同步用中性软底（常态动作），继续同步用主色（用户在等它），
 * 重置本地缓存用错误色（破坏性动作，且此时同步已被熔断）。
 */
const actionColor = computed(() => {
  if (summary.value.state === 'storage-error') return 'error' as const
  if (summary.value.state === 'paused') return 'primary' as const
  return 'neutral' as const
})

/**
 * 执行动作：**先关弹层再动手**，否则同步态一变、弹层内容跟着重排，手指容易点到别的按钮。
 *
 * - 正在同步 → 暂停：立即取消在途复制并清空队列（见 usePouchDb 的 pauseSync）；
 * - 已暂停 → 继续：恢复拉取，顺手发起一次同步（把暂停期间攒的变化尽快拿下来）；
 * - 本地存储故障 → 重置本地缓存：条目库已写不进去（配额/损坏），销毁重建是唯一有效的
 *   恢复动作，重置完成后再同步（必须等重建完成，否则复制会退回同一个坏库）；
 * - 其余 → 立即同步。
 */
function runAction() {
  const state = summary.value.state
  open.value = false

  if (state === 'syncing') {
    pouch.pauseSync()
    toast.add({
      title: '已暂停同步',
      description: '不再拉取新内容，点开同步面板可继续',
      color: 'neutral'
    })
    return
  }
  if (state === 'paused') pouch.resumeSync()
  if (state === 'storage-error') {
    void pouch.resetLocalData().then(() => {
      toast.add({
        title: '本地缓存已重置',
        description: '正在重新同步，请保持页面打开',
        color: 'neutral'
      })
      return sync()
    })
    return
  }
  void sync()
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ side: 'top', align: 'end', sideOffset: 6, collisionPadding: 12 }"
    :ui="{ content: 'z-50 w-64 p-3' }"
  >
    <UButton
      class="rounded-full"
      variant="ghost"
      color="neutral"
      size="xs"
      square
      :aria-label="`同步状态：${label}`"
    >
      <UIcon
        :name="ICONS[summary.state]"
        :class="[COLORS[summary.state], summary.state === 'syncing' ? 'animate-spin' : '']"
        class="size-4 shrink-0"
      />
    </UButton>

    <template #content>
      <div class="flex flex-col gap-1 text-xs">
        <span
          class="flex items-center gap-1.5 font-medium"
          :class="COLORS[summary.state]"
        >
          <UIcon
            :name="ICONS[summary.state]"
            class="size-3.5 shrink-0"
          />
          {{ label }}
        </span>
        <!-- key 取行号而不是行文本：明细行会重复（并发两个源都还没报进度时都是「已同步 0%」），
             拿文本当 key 会让 Vue 的 keyed diff 把旧节点解析成再也没人清理的孤儿 ——
             同步成功后弹层里会一直挂着上一轮的「已同步 0%」 -->
        <span
          v-for="(line, i) in details"
          :key="i"
          class="text-muted"
        >
          {{ line }}
        </span>
        <!-- 体积信息：口径见脚本里的 cloudLine / localLine 注释 -->
        <span
          v-if="cloudLine"
          class="text-muted"
        >
          {{ cloudLine }}
        </span>
        <span
          v-if="localLine"
          class="text-muted"
        >
          {{ localLine }}
        </span>

        <!-- 动作按钮铺满整行：移动端手指好点，也一眼看出这里只有一个动作。
             size="md" 是主题默认里带文字按钮的最小一档（sm 只有 28px 高，手指够不稳）；
             lg 以下再补到 min-h-10，与底部导航栏的 2.5rem 对齐，是这套 UI 在移动端的触摸基准 -->
        <UButton
          block
          class="mt-2 max-lg:min-h-10"
          :icon="ACTION_ICONS[summary.state]"
          :color="actionColor"
          variant="soft"
          size="md"
          :aria-label="actionLabel"
          @click="runAction"
        >
          {{ actionLabel }}
        </UButton>
      </div>
    </template>
  </UPopover>
</template>
