<script setup lang="ts">
/**
 * 同步状态指示器：侧边栏左下角用户菜单右侧的图标按钮（原先是那个没用的 chevron）。
 *
 * 悬停弹出详情：同步中看进度，失败看原因，成功看上次同步时间；点击行为随状态而变 ——
 * 同步中 → 暂停同步，已暂停 → 继续同步，其余 → 立即同步。
 * 状态判定与文案在 utils/syncStatusSummary 里（纯函数，便于单测）。
 */
import { computed } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'
import { useManualSync } from '~/composables/useManualSync'
import { summarizeSyncStatuses, syncStatusLabel, syncStatusDetails } from '~/utils/syncStatusSummary'
import type { SyncState } from '~/utils/syncStatusSummary'

const pouch = usePouchDb()
const summary = computed(() => summarizeSyncStatuses(pouch.syncStatuses, {
  paused: pouch.paused.value,
  storageError: pouch.storageBroken.value
}))
const label = computed(() => syncStatusLabel(summary.value.state))
const details = computed(() => syncStatusDetails(summary.value))

// 点击触发手动同步：与顶部工具栏的同步按钮共用逻辑，结果会有 toast 反馈。
// 这里不给按钮挂 loading —— 按钮一旦变 disabled 就会丢焦点，悬停中的弹层也会跟着收起；
// 同步中的反馈由状态图标本身（refresh-cw + 旋转）和 toast 承担。
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

/** 点击会做什么：同步中→暂停，已暂停→继续，本地存储故障→重置本地缓存，其余→立即同步 */
const actionLabel = computed(() => {
  if (summary.value.state === 'syncing') return '暂停同步'
  if (summary.value.state === 'paused') return '继续同步'
  if (summary.value.state === 'storage-error') return '重置本地缓存'
  return '立即同步'
})

/**
 * 点击：正在同步时点击是「暂停」——立即取消在途复制并清空队列（见 usePouchDb 的
 * pauseSync）；已暂停时点击是「继续」，顺手发起一次同步。
 *
 * 本地存储故障时点击是「重置本地缓存」：条目库已写不进去（配额/损坏），
 * 销毁重建是唯一有效的恢复动作，重置后自动重新同步。
 */
function handleClick() {
  if (summary.value.state === 'syncing') {
    pouch.pauseSync()
    toast.add({
      title: '已暂停同步',
      description: '剩余订阅源不再拉取，点击图标可继续',
      color: 'neutral'
    })
    return
  }
  if (summary.value.state === 'paused') pouch.resumeSync()
  if (summary.value.state === 'storage-error') {
    // 先等本地库销毁重建完成再发起同步：否则新库还没建好就复制，会退回同一个坏库
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
  <UTooltip
    disable-closing-trigger
    :delay-duration="120"
    :content="{ side: 'top', align: 'end', sideOffset: 6, collisionPadding: 12 }"
    :ui="{ content: 'block h-auto w-56 rounded-md px-3 py-2 whitespace-normal select-text' }"
  >
    <UButton
      class="rounded-full"
      variant="ghost"
      color="neutral"
      size="xs"
      square
      :aria-label="actionLabel"
      @click="handleClick"
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
        <span class="text-dimmed">点击{{ actionLabel }}</span>
      </div>
    </template>
  </UTooltip>
</template>
