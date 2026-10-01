<script setup lang="ts">
/**
 * 列表页右上角的「三个点」菜单：把页面级动作收拢成一个入口。
 *
 * 四个列表页都用它，但菜单内容按页面能力拼：
 *   时间线 / 分组页   同步订阅 + 全部标记为已读
 *   单源页           刷新订阅 + 编辑订阅 + 全部标记为已读 ｜ 取消订阅
 *   bot 产出页       刷新订阅 + 编辑订阅 + 全部标记为已读 ｜ 订阅 / 取消订阅
 *
 * 视图切换按钮**不在**菜单里（见 ListViewSwitcher）：它是高频的版式切换，留在外面一眼可见。
 * 同步状态（转圈 / 失败）体现在触发按钮与第一项上，所以收进菜单不会丢掉「一眼看到同步在跑」。
 */
import { computed } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useSyncAction } from '~/composables/useSyncAction'
import type { ManualSyncOutcome } from '~/composables/useManualSync'

const props = withDefaults(defineProps<{
  /** 限定同步范围的库 id；不传 = 所有已激活的库（同步全部订阅） */
  feedIds?: string[]
  /** 同步那一项的文案：单源 / bot 页是「刷新订阅」，聚合页是「同步订阅」 */
  syncLabel?: string
  /** 传了才显示订阅类动作（编辑订阅 / 取消订阅 / 订阅） */
  feedId?: string
  /** 当前列表有没有条目：没有就没什么可标记的 */
  hasEntries?: boolean
  /** 是否已订阅（bot 产出页在「订阅 / 取消订阅」之间切换）；不传按已订阅处理 */
  subscribed?: boolean
}>(), {
  feedIds: undefined,
  syncLabel: '同步订阅',
  feedId: undefined,
  hasEntries: undefined,
  subscribed: true
})

const emit = defineEmits<{
  'synced': [outcome: ManualSyncOutcome]
  'mark-all-read': []
  'edit': []
  'subscribe': []
  'unsubscribe': []
}>()

const { syncing, hasError, statusText, tooltipText, sync } = useSyncAction(() => props.feedIds)

async function handleSync() {
  const outcome = await sync()
  // 空转（上一轮还在跑）不发事件，与 SyncButton 一致
  if (outcome) emit('synced', outcome)
}

const items = computed<DropdownMenuItem[][]>(() => {
  const actions: DropdownMenuItem[] = [
    {
      label: syncing.value ? '同步中…' : props.syncLabel,
      description: statusText.value ?? undefined,
      icon: 'i-lucide-refresh-cw',
      disabled: syncing.value,
      onSelect: () => { void handleSync() }
    }
  ]

  if (props.feedId) {
    actions.push({
      label: '编辑订阅',
      icon: 'i-lucide-pencil',
      onSelect: () => emit('edit')
    })
  }

  actions.push({
    label: '全部标记为已读',
    icon: 'i-lucide-check-check',
    // 与「取消订阅」同色：都是不可撤销的批量动作（列表里只有已加载的那批会被标，见页面实现）
    color: 'error',
    disabled: props.hasEntries === false,
    onSelect: () => emit('mark-all-read')
  })

  const groups: DropdownMenuItem[][] = [actions]

  if (props.feedId) {
    groups.push([
      props.subscribed
        ? {
            label: '取消订阅',
            icon: 'i-lucide-bell-off',
            color: 'error',
            onSelect: () => emit('unsubscribe')
          }
        : {
            label: '订阅',
            icon: 'i-lucide-bell-plus',
            color: 'primary',
            onSelect: () => emit('subscribe')
          }
    ])
  }

  return groups
})
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      :icon="hasError ? 'i-lucide-alert-circle' : 'i-lucide-ellipsis-vertical'"
      :loading="syncing"
      :color="hasError ? 'error' : 'neutral'"
      :title="tooltipText"
      aria-label="更多操作"
      variant="ghost"
      size="sm"
    />
  </UDropdownMenu>
</template>
