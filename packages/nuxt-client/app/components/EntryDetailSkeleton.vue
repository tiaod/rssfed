<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /**
   * 期望的骨架高度（px），按 min-height 生效。
   *
   * 传「当前正显示的正文高度」时，加载下一篇期间弹窗会被撑到同样的尺寸，
   * 不会先缩成一小条再弹开；不传则用骨架自身的自然高度。
   */
  height?: number
}>(), { height: 0 })

/** 标题 + 元信息 + 段前间距的近似高度（h-7 + h-3 + 间距） */
const HEAD_BLOCK = 96
/** 每行正文条的高度 + 行距（h-4 + space-y-3） */
const LINE_STEP = 28
/** 缺省行数：与 EntryDetail 首屏的标题/元信息/段落节奏对齐 */
const BASE_LINES = 5
/** 行数上限：再高的目标高度交给 min-height，避免给超长文生成几百个脉冲节点 */
const MAX_LINES = 60
/** 行宽循环：让占位看起来像自然段落，而不是整齐的方块 */
const LINE_WIDTHS = ['w-full', 'w-[94%]', 'w-[88%]', 'w-[97%]', 'w-[64%]', 'w-[91%]', 'w-[78%]']

const lines = computed(() => {
  if (!props.height) return BASE_LINES
  return Math.min(MAX_LINES, Math.max(BASE_LINES, Math.ceil((props.height - HEAD_BLOCK) / LINE_STEP)))
})
</script>

<template>
  <!--
    正文骨架屏：标题 / 元信息 / 段落的节奏与 EntryDetail 对齐，
    全文未就位时占位，避免正文区空白或只剩标题（框体会先塌再弹）。
    给了 height 就按行高补足行数并兜底 min-height，把弹窗撑到指定尺寸。
  -->
  <div
    class="space-y-4"
    aria-busy="true"
    :style="height ? { minHeight: `${height}px` } : undefined"
  >
    <USkeleton class="h-7 w-[85%]" />
    <USkeleton class="h-3 w-44" />
    <div class="pt-2 space-y-3">
      <USkeleton
        v-for="i in lines"
        :key="i"
        class="h-4"
        :class="LINE_WIDTHS[(i - 1) % LINE_WIDTHS.length]"
      />
    </div>
  </div>
</template>
