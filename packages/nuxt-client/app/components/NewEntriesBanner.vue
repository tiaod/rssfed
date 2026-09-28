<script setup lang="ts">
/**
 * 「N 条新内容」提示条。
 *
 * 后台同步拿到的新条目不再直接插进列表（会把用户正在阅读的内容推走），
 * 而是在这里累计，用户点「显示」才上屏并回到列表顶部。
 *
 * 形态用 Nuxt UI 的 USeparator（中间插槽）：一条分隔线把「还没看的新内容」和下面的列表
 * 划开，中间放条数和操作按钮——条数在左、按钮在右，比整块横幅轻得多。
 *
 * 出现 / 消失不做 v-if 直接增删节点：外层容器在 `grid-template-rows` 的 0fr 与 1fr 之间
 * 过渡，高度连续变化，下面的列表就跟着整体平移，而不是"啪"地跳一下。
 * 收起时用 aria-hidden 让屏幕阅读器也跳过它。
 *
 * 间距：面板 #body 自带 24px 内边距，分隔线又在内容行里垂直居中，若再上下对称加 padding，
 * 线上方会变成 24+12+12=48px、下方只有 24px。所以上方不加 padding，并在展开时用 -mt-3
 * 抵消面板内边距的一半，让线到导航栏和线到列表都是 24px；收起时不留负边距，
 * 列表仍保持原本的 24px 上边距。
 */
const props = defineProps<{
  /** 待上屏的新条目数（0 表示收起） */
  count: number
}>()

const emit = defineEmits<{
  apply: []
}>()

const expanded = computed(() => props.count > 0)
</script>

<template>
  <div
    class="grid transition-all duration-300 ease-out"
    :class="expanded
      ? '-mt-3 grid-rows-[1fr] opacity-100'
      : 'grid-rows-[0fr] opacity-0'"
    :aria-hidden="!expanded"
  >
    <div class="overflow-hidden">
      <USeparator
        size="xs"
        class="pb-3"
      >
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-arrow-up"
            class="size-3.5 text-primary"
          />
          <span class="text-sm text-primary">
            {{ props.count }} 条新内容
          </span>
          <UButton
            label="显示"
            color="primary"
            variant="soft"
            size="xs"
            @click="emit('apply')"
          />
        </div>
      </USeparator>
    </div>
  </div>
</template>
