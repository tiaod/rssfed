<script setup lang="ts">
/**
 * 全局同步进度条：时间线库 / 用户状态库处于同步中（排队/进行中）时，
 * 在页面顶部显示真实进度条与百分比，全部完成后自动消失。
 * 放置于 app.vue 根组件，所有页面共享。
 *
 * 具体在拉什么由左下角指示器的弹层说（那里逐条列出目标与已写入条数），
 * 这里只留一个百分比：同步目标固定为两个，报「N 个」没有信息量。
 *
 * 进度按「库内进度」加权（见 utils/syncStatusSummary）：时间线库几千条拉到一半时，
 * 进度条会跟着走到一半，而不是停在 done/total 上等整个库结束。
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
          正在同步（{{ progress }}%）
        </template>
      </span>
    </div>
  </div>
</template>
