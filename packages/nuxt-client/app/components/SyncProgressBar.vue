<script setup lang="ts">
/**
 * 全局同步进度条：任一 feed/用户状态库处于同步中（排队/进行中）时，
 * 在页面顶部显示真实进度条与统计信息（正在同步几个、剩余几个），
 * 全部完成后自动消失。放置于 app.vue 根组件，所有页面共享。
 *
 * 进度按「源内进度」加权（见 utils/syncStatusSummary）：一个几千条的源拉到一半，
 * 进度条会跟着走到一半，而不是停在 done/total 上等它整源结束。
 *
 * 本地存储故障（配额耗尽 / 数据库损坏）时改为常驻警示条：此时同步已被熔断，
 * 继续显示进度只会让人以为还在正常拉取，真正要做的是重置本地缓存。
 */
import { computed } from 'vue'
import { usePouchDb } from '~/composables/usePouchDb'
import { summarizeSyncStatuses } from '~/utils/syncStatusSummary'

const pouch = usePouchDb()

/** 本地存储故障说明（非空即熔断） */
const storageError = computed(() => pouch.storageBroken.value)

/**
 * 汇总同步状态：与左下角指示器共用同一个纯函数，
 * 避免顶部进度条与指示器对「进度是多少、还剩几个」给出两套说法。
 */
const summary = computed(() => summarizeSyncStatuses(pouch.syncStatuses, {
  paused: pouch.paused.value,
  storageError: pouch.storageBroken.value
}))

/** 当前正在同步的库数量 */
const syncingCount = computed(() => summary.value.syncing)

/** 剩余（排队 + 进行中） */
const remainingCount = computed(() => summary.value.remaining)

/** 加权后的真实进度（0-100） */
const progress = computed(() => summary.value.progress)

/** 有同步活动、或已熔断时显示进度条 */
const isSyncing = computed(() => remainingCount.value > 0 || !!storageError.value)
</script>

<template>
  <div
    v-if="isSyncing"
    class="fixed inset-x-0 top-0 z-[100] pointer-events-none"
    aria-hidden="true"
  >
    <UProgress
      :model-value="storageError ? 100 : progress"
      size="xs"
      :color="storageError ? 'error' : 'primary'"
    />
    <div class="flex justify-center">
      <span
        class="mt-1 rounded-full px-2.5 py-1 text-xs shadow-sm backdrop-blur"
        :class="storageError
          ? 'bg-error/10 text-error'
          : 'bg-background/85 text-muted'"
      >
        <template v-if="storageError">
          {{ storageError }}
        </template>
        <template v-else>
          正在同步 {{ syncingCount }} 个 · 剩余 {{ remainingCount }} 个（{{ progress }}%）
        </template>
      </span>
    </div>
  </div>
</template>
