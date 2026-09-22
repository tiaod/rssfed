<script setup lang="ts">
/**
 * 手动同步按钮：点击立即从远端拉取最新数据（syncNow），并展示同步状态。
 *
 * 不传 feedIds 时作用于所有已激活的库（feed + 用户状态库），
 * 传入时仅作用于指定 feed。同步走增量：没有新内容的源会被跳过（见 syncNow），
 * 因此点击通常很快完成。状态展示：
 * - 同步中：按钮转圈
 * - 失败：图标变红，tooltip 显示错误详情（可点击重试）
 * - 成功：tooltip 显示上次同步时间
 */
const props = withDefaults(defineProps<{ feedIds?: string[] }>(), {
  feedIds: undefined
})

const pouch = usePouchDb()
const toast = useToast()
const syncing = ref(false)

// 相关库的 id 集合（缺省 = 所有已激活的库）
const relatedIds = computed(() => {
  if (props.feedIds?.length) return props.feedIds
  return Object.keys(pouch.syncStatuses)
})

// 仅在手动同步进行中禁用按钮；live 同步的 syncing 状态只驱动全局进度条，
// 否则初始同步因连接竞争卡住时按钮也会禁用，用户将无法重试。
const isSyncing = computed(() => syncing.value)

const hasError = computed(() =>
  relatedIds.value.some(id => pouch.syncStatuses[id]?.status === 'error')
)

const errorDetail = computed(() => {
  const err = relatedIds.value
    .map(id => pouch.syncStatuses[id]?.error)
    .find(Boolean)
  return err ?? '同步失败，请重试'
})

// 相关库中最近一次同步时间（取最早的那个）
const lastSyncedAt = computed(() => {
  const times = relatedIds.value
    .map(id => pouch.syncStatuses[id]?.lastSyncedAt)
    .filter((t): t is string => !!t)
  if (!times.length) return null
  return times.reduce((min, t) => (t < min ? t : min))
})

/** 相对时间展示：1 分钟内「刚刚」，1 小时内「x 分钟前」，更早显示时分 */
function formatRelativeTime(iso: string) {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const tooltipText = computed(() => {
  if (isSyncing.value) return '同步中…'
  if (hasError.value) return errorDetail.value
  if (lastSyncedAt.value) return `上次同步：${formatRelativeTime(lastSyncedAt.value)}`
  return '同步'
})

async function handleSync() {
  syncing.value = true
  try {
    const result = await pouch.syncNow(props.feedIds)
    if (result.failed.length > 0) {
      toast.add({
        title: '同步失败',
        description: result.failed.map(f => f.error).join('；'),
        color: 'error'
      })
    } else if (result.ok.length > 0) {
      toast.add({
        title: '同步完成',
        // 被增量过滤跳过的源也报出来，避免「点了一下没反应」的困惑
        description: result.skipped > 0 ? `另有 ${result.skipped} 个订阅源无更新，已跳过` : undefined,
        color: 'success'
      })
    } else {
      toast.add({ title: '已是最新', description: '所选订阅源都没有新内容', color: 'success' })
    }
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <UTooltip :text="tooltipText">
    <UButton
      :icon="hasError ? 'i-lucide-alert-circle' : 'i-lucide-refresh-cw'"
      :loading="isSyncing"
      :color="hasError ? 'error' : 'neutral'"
      variant="ghost"
      size="sm"
      aria-label="同步"
      @click="handleSync"
    />
  </UTooltip>
</template>
