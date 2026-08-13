<script setup lang="ts">
/**
 * 手动同步按钮：点击立即从远端拉取最新数据（syncNow），并展示同步状态。
 *
 * 不传 feedIds 时作用于所有已激活的库（feed + 用户状态库），
 * 传入时仅作用于指定 feed。状态展示：
 * - 同步中：按钮转圈
 * - 失败：图标变红，tooltip 显示错误详情（可点击重试）
 * - 成功：tooltip 显示上次同步时间
 */
const props = withDefaults(defineProps<{ feedIds?: string[] }>(), {
  feedIds: undefined,
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
        color: 'error',
      })
    } else if (result.ok.length > 0) {
      toast.add({ title: '同步完成', color: 'success' })
    }
  } finally {
    syncing.value = false
  }
}

/**
 * 重置本地缓存：清空本地 PouchDB 并全量重新同步。
 * 用于本地数据与服务端冲突/损坏（如服务端库重建后旧数据残留、封面缺失）的场景。
 * 采用双击确认（第一次点击进入确认态，4 秒内再点执行），避免误触。
 */
const resetting = ref(false)
const confirmReset = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
async function handleReset() {
  if (resetting.value) return
  if (!confirmReset.value) {
    // 第一次点击：进入确认态
    confirmReset.value = true
    confirmTimer = setTimeout(() => { confirmReset.value = false }, 4000)
    return
  }
  // 第二次点击：确认执行
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmReset.value = false
  resetting.value = true
  try {
    await pouch.resetLocalData()
    await pouch.syncNow(props.feedIds)
    toast.add({ title: '本地缓存已重置，正在重新同步', color: 'success' })
  } catch (e: any) {
    toast.add({ title: '重置失败', description: String(e?.message ?? e), color: 'error' })
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="flex items-center gap-1">
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
    <UTooltip :text="confirmReset ? '再次点击确认重置' : '重置本地缓存并重新同步（本地数据异常时使用）'">
      <UButton
        :icon="confirmReset ? 'i-lucide-triangle-alert' : 'i-lucide-rotate-ccw'"
        :loading="resetting"
        :color="confirmReset ? 'error' : 'neutral'"
        variant="ghost"
        size="sm"
        aria-label="重置本地缓存"
        @click="handleReset"
      />
    </UTooltip>
  </div>
</template>
