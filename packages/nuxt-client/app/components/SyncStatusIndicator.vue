<script setup lang="ts">
/**
 * 同步状态指示器：侧边栏左下角用户菜单右侧的图标按钮（原先是那个没用的 chevron）。
 *
 * 只订阅同步状态（usePouchSyncStatus），不构造整套 PouchDB 操作闭包 —— 任何库同步
 * 完成都只会重渲染这一个小组件，不会波及侧边栏其余部分（依赖留在小组件内部）。
 * 悬停弹出详情：同步中看进度，失败看原因，成功看上次同步时间；点击立即手动同步。
 * 状态判定与文案都在 utils/syncStatusSummary 里，做成纯函数以便单测。
 */
import { summarizeSyncStatuses, syncStatusLabel, syncStatusDetails } from '~/utils/syncStatusSummary'
import type { SyncState } from '~/utils/syncStatusSummary'

const syncStatuses = usePouchSyncStatus()
const summary = computed(() => summarizeSyncStatuses(syncStatuses))
const label = computed(() => syncStatusLabel(summary.value.state))
const details = computed(() => syncStatusDetails(summary.value))

// 点击触发手动同步：与顶部工具栏的同步按钮共用逻辑，结果会有 toast 反馈。
// 这里不给按钮挂 loading —— 按钮一旦变 disabled 就会丢焦点，悬停中的弹层也会跟着收起；
// 同步中的反馈由状态图标本身（refresh-cw + 旋转）和 toast 承担。
const { sync } = useManualSync()

const ICONS: Record<SyncState, string> = {
  syncing: 'i-lucide-refresh-cw',
  error: 'i-lucide-alert-circle',
  success: 'i-lucide-circle-check',
  idle: 'i-lucide-cloud'
}

const COLORS: Record<SyncState, string> = {
  syncing: 'text-primary',
  error: 'text-error',
  success: 'text-success',
  idle: 'text-muted'
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
      aria-label="立即同步"
      @click="sync"
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
        <span class="text-dimmed">点击立即同步</span>
      </div>
    </template>
  </UTooltip>
</template>
