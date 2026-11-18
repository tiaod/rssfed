<script setup lang="ts">
/**
 * 设置的分区导航：宽屏左侧竖栏与窄屏第一级列表共用同一份。
 *
 * 两处必须长得一样 —— 窄屏原先单独做了一套「带边框的卡片 + 右侧 chevron」，
 * 和宽屏的 ghost 按钮列表不是一回事，同一个弹窗在两种宽度下像两个产品。
 * 所以这里不接任何「长什么样」的参数，只接选中态与两个动作。
 *
 * 选中态只给宽屏的竖栏：那里的列表是「正在显示的分区」，高亮说明右边是什么。
 * 窄屏这一级只是入口，点一行就离开列表进详情，弹窗里没有一个「当前」可标 ——
 * 带上高亮反而像「这一项已被选中 / 已开启」。所以窄屏的调用方传 `active={null}`，
 * 这里不做宽度判断（判定交给调用方的 sm 断点，组件本身不需要读窗口宽度）。
 */
import { SETTINGS_SECTIONS, type SettingsSection } from '~/composables/useSettingsModal'

defineProps<{
  /** 当前分区（只有宽屏竖栏传）；为 null 时不标任何一项 */
  active?: SettingsSection | null
}>()

const emit = defineEmits<{
  select: [section: SettingsSection]
  subscriptions: []
}>()
</script>

<template>
  <div class="flex flex-col gap-1">
    <UButton
      v-for="item in SETTINGS_SECTIONS"
      :key="item.value"
      :icon="item.icon"
      :label="item.label"
      block
      size="md"
      :color="active === item.value ? 'primary' : 'neutral'"
      :variant="active === item.value ? 'soft' : 'ghost'"
      class="justify-start"
      :aria-current="active === item.value ? 'page' : undefined"
      @click="emit('select', item.value)"
    />

    <!-- 订阅管理不属于设置分区：点一下就关弹窗跳页，trailing 图标表明「会离开这里」 -->
    <div class="my-1 border-t border-default" />
    <UButton
      class="justify-start"
      icon="i-lucide-rss"
      trailing-icon="i-lucide-external-link"
      label="订阅管理"
      block
      size="md"
      color="neutral"
      variant="ghost"
      @click="emit('subscriptions')"
    />
  </div>
</template>
