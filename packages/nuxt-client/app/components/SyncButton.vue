<script setup lang="ts">
/**
 * 工具栏同步按钮：点击立即从远端拉取最新数据（syncNow），并展示同步状态。
 *
 * 状态与文案都来自 `useSyncAction`（列表页的「三个点」菜单里那一项也用它，见 ListActionsMenu）。
 * 同步走增量：服务端本轮没有新内容时直接返回，因此点击通常很快完成。
 * 不再接收「限定哪些源」的参数来决定同步范围 —— 客户端只同步一个时间线库，范围写死在服务端。
 * `syncScope` 只决定**反馈口径**（toast 条数、outcome.added）：单源 / 分组页传自己列表的
 * feedId，就不会因为别的源有更新而报「新增 N 条」；不传（首页这种全局按钮）报全库。
 *
 * 同步结束后把结果以 `synced` 事件抛出（附带本轮是否写入新条目）。列表页据此决定：
 * 本轮没有新条目时可以顺手把攒着的「已同步 N 条」展开上屏（见 useSyncedEntryList
 * 的 applyNewIfSyncAddedNothing），免得用户再点一次「查看」。
 */
import { useSyncAction } from '~/composables/useSyncAction'
import type { ManualSyncOutcome } from '~/composables/useManualSync'

const props = withDefaults(defineProps<{
  /** 反馈口径：只报这些源的同步条数（见文件头）；不传 = 全库 */
  syncScope?: readonly string[]
}>(), {
  syncScope: undefined
})

const emit = defineEmits<{
  /** 本轮手动同步结束（重入导致的空转不发事件） */
  synced: [outcome: ManualSyncOutcome]
}>()

const { syncing, hasError, tooltipText, sync } = useSyncAction()

/** 点击同步：结束后把本轮结果交给页面（null = 上一轮还在跑，本轮没执行） */
async function handleSync() {
  const outcome = await sync(props.syncScope)
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
