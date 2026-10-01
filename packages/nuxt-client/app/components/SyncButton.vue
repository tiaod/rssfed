<script setup lang="ts">
/**
 * 工具栏同步按钮：点击立即从远端拉取最新数据（syncNow），并展示同步状态。
 *
 * 状态与文案都来自 `useSyncAction`（列表页的「三个点」菜单里那一项也用它，见 ListActionsMenu）。
 * 同步走增量：没有新内容的源会被跳过，因此点击通常很快完成。
 *
 * 同步结束后把结果以 `synced` 事件抛出（附带本轮是否写入新条目）。列表页据此决定：
 * 本轮没有新条目时可以顺手把攒着的「已同步 N 条」展开上屏（见 useSyncedEntryList
 * 的 applyNewIfSyncAddedNothing），免得用户再点一次「查看」。
 */
import { useSyncAction } from '~/composables/useSyncAction'
import type { ManualSyncOutcome } from '~/composables/useManualSync'

const props = withDefaults(defineProps<{ feedIds?: string[] }>(), {
  feedIds: undefined
})

const emit = defineEmits<{
  /** 本轮手动同步结束（重入导致的空转不发事件） */
  synced: [outcome: ManualSyncOutcome]
}>()

const { syncing, hasError, tooltipText, sync } = useSyncAction(() => props.feedIds)

/** 点击同步：结束后把本轮结果交给页面（null = 上一轮还在跑，本轮没执行） */
async function handleSync() {
  const outcome = await sync()
  if (outcome) emit('synced', outcome)
}
</script>

<template>
  <UTooltip :text="tooltipText">
    <UButton
      :icon="hasError ? 'i-lucide-alert-circle' : 'i-lucide-refresh-cw'"
      :loading="syncing"
      :color="hasError ? 'error' : 'neutral'"
      variant="ghost"
      size="sm"
      aria-label="同步"
      @click="handleSync"
    />
  </UTooltip>
</template>
