<script setup lang="ts">
import { computed } from 'vue'

/**
 * 「只看未读」下的空态。
 *
 * 三种情况必须分开说，否则用户会把「还没扫完」当成「没有未读」：
 *   正在扫描 / 扫了这批没找到、还能继续扫 / 真的没有未读。
 * 「已扫描 N 条」是如实报数：用户据此判断还要不要继续往下找（见 useUnreadFilter 的 maxScan）。
 */
const props = defineProps<{
  /** 正在扫描（首次扫描还没出结果） */
  probing: boolean
  /** 本轮已扫描的行数 */
  scanned: number
  /** 扫描范围内还有没有更多（true = 可以先「继续扫描」，而不是断言没有未读） */
  hasMore: boolean
}>()

const emit = defineEmits<{
  'scan-more': []
  'show-all': []
}>()

const text = computed(() => {
  if (props.probing) return '正在扫描未读…'
  if (props.hasMore) return `已扫描 ${props.scanned} 条，暂未发现未读`
  return '这个列表里没有未读条目'
})
</script>

<template>
  <div class="flex flex-col items-center py-12 gap-4">
    <UIcon
      :name="probing ? 'i-lucide-loader-circle' : 'i-lucide-circle-check'"
      class="size-12 text-muted"
      :class="probing ? 'animate-spin' : undefined"
    />
    <p class="text-muted">
      {{ text }}
    </p>
    <div
      v-if="!probing"
      class="flex gap-2"
    >
      <!-- 扫到单轮上限时不当成「没有未读」：给一个继续往下找的入口 -->
      <UButton
        v-if="hasMore"
        variant="soft"
        color="neutral"
        @click="emit('scan-more')"
      >
        继续扫描
      </UButton>
      <UButton
        variant="outline"
        color="neutral"
        @click="emit('show-all')"
      >
        显示全部
      </UButton>
    </div>
  </div>
</template>
