<script setup lang="ts">
/**
 * 设置弹窗里的一行：说明在左、控件在右，可带一个彩色图标。
 *
 * 不用 UFormField：它的默认版式是「标签在上、控件在下」，在弹窗这种窄而高的容器里
 * 会把一列选项拉得很长；左右分栏才能在一屏里放下更多项，也与常见桌面应用的设置窗口一致。
 * 窄屏退回上下排列，否则说明文字会被控件挤成两三个字一行。
 *
 * 图标底色按 `tone` 给（参考 macOS 设置面板）：一组设置里图标是同一个色系，
 * 用户靠颜色就能认出「这几行是一类」，不必读标题。
 */
import type { SettingsTone } from '~/composables/useSettingsModal'

withDefaults(defineProps<{
  label: string
  description?: string
  icon?: string
  tone?: SettingsTone
}>(), {
  tone: 'blue'
})

/** 图标底色：只写静态类名，Tailwind 才能扫到 */
const TONE_CLASS: Record<SettingsTone, string> = {
  blue: 'bg-blue-500',
  purple: 'bg-violet-500',
  orange: 'bg-amber-500',
  red: 'bg-rose-500',
  green: 'bg-emerald-500',
  slate: 'bg-slate-500'
}
</script>

<template>
  <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
    <div class="flex min-w-0 items-start gap-3">
      <span
        v-if="icon"
        class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-white"
        :class="TONE_CLASS[tone]"
        aria-hidden="true"
      >
        <UIcon
          :name="icon"
          class="size-4"
        />
      </span>
      <div class="min-w-0">
        <p class="text-sm font-medium text-default">
          {{ label }}
        </p>
        <p
          v-if="description"
          class="mt-1 text-xs/relaxed text-muted"
        >
          {{ description }}
        </p>
      </div>
    </div>
    <div class="shrink-0 sm:self-center">
      <slot />
    </div>
  </div>
</template>
