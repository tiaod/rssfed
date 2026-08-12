<script setup lang="ts">
/**
 * 全局同步进度条：任一 feed/用户状态库处于同步中（排队/进行中）时，
 * 在页面顶部显示真实进度条与统计信息（正在同步几个、剩余几个），
 * 全部完成后自动消失。放置于 app.vue 根组件，所有页面共享。
 */
const pouch = usePouchDb()

/** 本轮所有待同步的库数量（含排队中/进行中/已完成） */
const total = computed(() => Object.keys(pouch.syncStatuses).length)

/** 已完成的库数量（成功或失败） */
const doneCount = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'idle' || s.status === 'error').length
)

/** 当前正在同步的库数量 */
const syncingCount = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'syncing').length
)

/** 排队等待中的库数量 */
const queuedCount = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'queued').length
)

/** 剩余（排队 + 进行中） */
const remainingCount = computed(() => queuedCount.value + syncingCount.value)

/** 有同步活动时显示进度条 */
const isSyncing = computed(() => remainingCount.value > 0)

/** 真实进度（0-100） */
const progress = computed(() =>
  total.value === 0 ? 0 : Math.round(doneCount.value / total.value * 100)
)
</script>

<template>
  <div
    v-if="isSyncing"
    class="fixed inset-x-0 top-0 z-[100] pointer-events-none"
    aria-hidden="true"
  >
    <UProgress
      :model-value="progress"
      size="xs"
      color="primary"
    />
    <div class="flex justify-center">
      <span class="mt-1 rounded-full bg-background/85 px-2.5 py-1 text-xs text-muted shadow-sm backdrop-blur">
        正在同步 {{ syncingCount }} 个 · 剩余 {{ remainingCount }} 个（{{ progress }}%）
      </span>
    </div>
  </div>
</template>
