<script setup lang="ts">
/**
 * 列表视图切换按钮：放在各列表页导航栏的同步按钮旁边。
 *
 * 单个按钮 + 下拉菜单（而不是一排分段按钮）：手机上的导航栏右侧已经有同步按钮和
 * 页面自己的操作，「取消订阅」这类还带文字，四个图标并排会挤成一行。菜单里每项带勾选态，
 * 选中态由当前视图派生（与 UserMenu 的主题选择同一套写法）。
 *
 * 触发按钮保持**纯图标**（和右边的「标记已读」「⋮」一致，导航栏右侧不排字、也不加额外装饰）：
 * 版式图标显示当前视图，「点一下能选」靠 tooltip / aria-label 里的「点击切换（当前：…）」说明，
 * 点开后的菜单每项带勾选态。这里不再单挂一个 ▾ —— 视觉上要简洁统一。
 *
 * 这里只负责「切换本次会话的视图」和「撤销会话内切换」；持久化的默认值在
 * 通用设置 / 编辑订阅 / 订阅管理页的分组行里配置，避免顺手点一下就把配置改掉。
 */
import { computed, onMounted, ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { LIST_VIEWS, LIST_VIEW_META, DEFAULT_LIST_VIEW, type ListView } from '~/utils/listViews'

const props = defineProps<{
  view: ListView
  /** 当前上下文被手动切过（会话内）：菜单里才给出「恢复默认视图」 */
  overridden?: boolean
}>()

const emit = defineEmits<{
  'update:view': [view: ListView]
  'reset': []
}>()

const items = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = [
    LIST_VIEWS.map(value => ({
      label: LIST_VIEW_META[value].label,
      description: LIST_VIEW_META[value].description,
      icon: LIST_VIEW_META[value].icon,
      type: 'checkbox' as const,
      checked: props.view === value,
      // 不走 toggle 语义：点任意一项都把视图切到该项
      onUpdateChecked: () => emit('update:view', value)
    }))
  ]

  // 会话内切过才提示「恢复」：刷新页面本来也会回到默认，这里给不想等刷新的用户一个出口
  if (props.overridden) {
    groups.push([
      { label: '恢复默认视图', icon: 'i-lucide-undo-2', onSelect: () => emit('reset') }
    ])
  }

  return groups
})

/**
 * 首帧固定按默认视图渲染，挂载后再切到实际视图。
 *
 * 默认视图可能来自 localStorage（通用设置），服务端渲染时读不到 —— 直接按实际值渲染，
 * 服务端产物与客户端状态就不一致。而 Vue 对 hydration 的属性 / class 不一致只报警不修正
 * （提示原文：this mismatch is check-only. The DOM will not be rectified in prod），
 * 于是按钮图标和 tooltip 会一直停在服务端那一版，直到用户手动切一次视图。
 * 挂载闸一下：首帧两边都是默认视图，之后正常跟随。
 *
 * 菜单里的勾选态不受影响 —— 菜单是点击后才挂载的，本来就没有 SSR 产物。
 */
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

const meta = computed(() => LIST_VIEW_META[mounted.value ? props.view : DEFAULT_LIST_VIEW])
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      :icon="meta.icon"
      :title="`视图：${meta.label}（点击切换）`"
      :aria-label="`切换视图（当前：${meta.label}）`"
      variant="ghost"
      color="neutral"
      size="sm"
    />
  </UDropdownMenu>
</template>
