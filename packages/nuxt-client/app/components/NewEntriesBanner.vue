<script setup lang="ts">
/**
 * 「N 条新内容」提示条。
 *
 * 后台同步拿到的新条目不再直接插进列表（会把用户正在阅读的内容推走），
 * 而是在这里累计，用户点一下才上屏并回到列表顶部。
 *
 * 外层用 h-0 包裹：提示条不占文档流高度，出现/消失不会把列表推动一格；
 * sticky 让用户滚到列表深处时也能看到并点击。
 */
const props = defineProps<{
  /** 待上屏的新条目数 */
  count: number
}>()

const emit = defineEmits<{
  apply: []
}>()
</script>

<template>
  <div class="pointer-events-none sticky top-2 z-20 flex h-0 justify-center">
    <UButton
      class="pointer-events-auto shadow-lg"
      size="sm"
      color="primary"
      icon="i-lucide-arrow-up"
      :aria-label="`显示 ${props.count} 条新内容`"
      aria-live="polite"
      @click="emit('apply')"
    >
      {{ props.count }} 条新内容
    </UButton>
  </div>
</template>
