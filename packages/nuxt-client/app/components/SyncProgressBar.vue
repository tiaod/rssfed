<script setup lang="ts">
/**
 * 全局同步进度条：任一 feed/用户状态库处于同步中（手动同步或首次进入页面时的
 * live 同步）时，在页面顶部显示一条不确定进度动画，同步完成或失败后自动消失。
 *
 * 放置于 app.vue 根组件，所有页面共享。
 */
const pouch = usePouchDb()

// 任一库同步中则显示进度条
const isSyncing = computed(() =>
  Object.values(pouch.syncStatuses).some(s => s.status === 'syncing')
)

// 当前同步中的库数量（live 初始同步可能多个并发，手动同步为串行）
const syncingCount = computed(() =>
  Object.values(pouch.syncStatuses).filter(s => s.status === 'syncing').length
)
</script>

<template>
  <div
    v-if="isSyncing"
    class="fixed inset-x-0 top-0 z-[100] pointer-events-none"
    aria-hidden="true"
  >
    <UProgress
      :model-value="null"
      animation="carousel"
      size="xs"
      color="primary"
    />
  </div>
</template>
