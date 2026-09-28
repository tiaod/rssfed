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
const summary = computed(() => summarizeSyncStatuses(pouch.syncStatuses, { paused: pouch.paused.value }))
const label = computed(() => syncStatusLabel(summary.value.state))
const details = computed(() => syncStatusDetails(summary.value))

// 点击触发手动同步：与顶部工具栏的同步按钮共用逻辑，结果会有 toast 反馈。
// 这里不给按钮挂 loading —— 按钮一旦变 disabled 就会丢焦点，悬停中的弹层也会跟着收起；
// 同步中的反馈由状态图标本身（refresh-cw + 旋转）和 toast 承担。
const { sync } = useManualSync()
const toast = useToast()

const ICONS: Record<SyncState, string> = {
  syncing: 'i-lucide-refresh-cw',
  paused: 'i-lucide-circle-pause',
  error: 'i-lucide-alert-circle',
  success: 'i-lucide-circle-check',
  idle: 'i-lucide-cloud'
}

const COLORS: Record<SyncState, string> = {
  syncing: 'text-primary',
  paused: 'text-warning',
  error: 'text-error',
  success: 'text-success',
  idle: 'text-muted'
}

/** 点击会做什么：同步中→暂停，已暂停→继续，其余→立即同步（同时用作 aria-label） */
const actionLabel = computed(() => {
  if (summary.value.state === 'syncing') return '暂停同步'
  if (summary.value.state === 'paused') return '继续同步'
  return '立即同步'
})

/**
 * 点击：正在同步时点击是「暂停」——立即取消在途复制并清空队列（见 usePouchDb 的
 * pauseSync）；已暂停时点击是「继续」，顺手发起一次同步。
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
        <span
          v-for="line in details"
          :key="line"
          class="text-muted"
        >
          {{ line }}
        </span>
        <span class="text-dimmed">点击{{ actionLabel }}</span>
      </div>
    </template>
  </UTooltip>
</template>
