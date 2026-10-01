<script setup lang="ts">
/**
 * 「已同步 N 条」提示条。
 *
 * 同步（后台或手动）只负责把数据拉到本地并报数，绝不改列表；用户点「查看」才重新
 * 从本地库加载最新内容并回到顶部。这样同步永远不会把用户正在读的内容推走。
 *
 * 形态用 Nuxt UI 的 USeparator（中间插槽）：一条分隔线把「还没看的新内容」和下面的列表
 * 划开，中间放条数和操作按钮——条数在左、按钮在右，比整块横幅轻得多。
 *
 * 高度压到最紧：没有底部内边距，与导航栏之间也只留 mt-2 / sm:mt-3。常驻形态下它固定在
 * 列表上方，多占的每一像素都在挤内容；线下面到第一张卡片的间距由列表自己的 paddingStart 提供。
 *
 * 出现 / 消失不做 v-if 直接增删节点：外层容器在 `grid-template-rows` 的 0fr 与 1fr 之间
 * 过渡，高度连续变化，常驻形态下的列表就跟着整体平移，而不是"啪"地跳一下。
 *
 * **两种形态**：
 *   - 常驻（默认）：参与布局，占列表上方一条高度，适合必须始终可见的列表。
 *   - 浮层（`floating`）：绝对定位盖在滚动区顶部，**不占布局高度**，展开 / 收起既不推动
 *     内容也不惊动虚拟化——所以只有它适合再叠一层「滚动方向控制显隐」（`visible`）。
 *
 * 折叠态挂 `inert`（不可聚焦 + 移出无障碍树），并且在点「查看」时把焦点还给页面。
 * 两件事要一起做：用户点完「查看」计数就归零，这条线立刻折叠并挂 aria-hidden，而焦点还
 * 落在那个按钮上——Chrome 会把 aria-hidden 拦下来并报「Blocked aria-hidden on an element
 * because its descendant retained focus」。
 *   - 只靠 inert 不够：实测给它设上 inert 后 activeElement 依然指着按钮，Chrome 并不会
 *     把已经在里面的焦点请出去（它只挡新的聚焦），所以还要显式 blur；
 *   - 两处属性顺序也不能反：inert 写在 aria-hidden 前面，属性是按模板顺序 patch 的；
 *   - inert 必须用 undefined 摘除（`:inert="expanded ? undefined : true"`）：Vue 的
 *     specialBooleanAttrs 里没有 inert，写成 false 会渲染成 inert="false" —— 布尔属性
 *     只要存在就生效，等于没摘。
 *
 * **常驻形态不按滚动方向隐藏**。试过两版都不划算：塌陷高度会让 ScrollArea 的高度跟着变，
 * 虚拟化立刻重新测量、正在读的内容抽风（实测滚 600px，scrollTop 能被推到 3528）；
 * 保留占位只把文字淡掉的话，空间一寸没让出来，等于没隐藏，还多一层残影。
 * 浮层形态没有这个问题（高度为零、不参与布局），方向隐藏由使用方通过 `visible` 控制。
 *
 * 底部再压一条 12px 的渐隐带（细节见模板里的注释），滚过的内容在提示条下缘淡出；
 * 浮层形态下这条带子正好抹掉「内容从提示条下面钻过去」的硬边。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 待查看的新条目数（0 表示收起） */
    count: number
    /**
     * 浮层形态：绝对定位盖在滚动区顶部（使用方容器需 `relative`），不占布局高度。
     * 展开 / 收起不会推动下面的内容，虚拟化也不必重测。
     */
    floating?: boolean
    /**
     * 因外部原因（如滚动方向）临时隐藏：为 false 时按「无新条目」折叠，过渡与焦点处理完全一致。
     */
    visible?: boolean
  }>(),
  {
    // 必须显式声明默认值：Vue 会把**未传的 Boolean prop 填成 false**，靠 `visible !== false`
    // 兜底是错的——时间线 / 分类页 / Bot 产出页只传 count，会被整体折叠掉。
    floating: false,
    visible: true
  }
)

const emit = defineEmits<{
  apply: []
}>()

const expanded = computed(() => props.count > 0 && props.visible)

/**
 * 点「查看」：先把焦点还给页面，再交给列表去刷新。
 *
 * 顺序不能反——emit 之后计数归零、组件折叠并挂 aria-hidden，如果焦点还在按钮里，
 * Chrome 会拦下 aria-hidden 并报「后代仍有焦点」。
 *
 * 优先 blur 这个按钮本身；拿不到事件对象（UButton 是把 @click 收成 onClick prop 再透传
 * 原生事件的，属于它的内部实现）就退回当前焦点元素 —— 此刻焦点本来就该在这个按钮上。
 */
function handleApply(event?: MouseEvent) {
  const target = event?.currentTarget ?? document.activeElement
  if (target instanceof HTMLElement) target.blur()
  emit('apply')
}
</script>

<template>
  <div
    class="grid transition-all duration-300 ease-out"
    :class="[
      // 定位由形态决定：两个类同时出现时谁生效取决于 CSS 里的先后顺序，不能都写上
      props.floating
        ? 'absolute inset-x-0 top-0 z-20 bg-[var(--ui-bg)] px-4 pt-2 sm:px-6 sm:pt-3'
        : 'relative',
      expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      // 常驻形态展开时才留上边距；浮层形态贴住滚动区顶部，外边距由自己的 pt 承担
      expanded && !props.floating ? 'mt-2 sm:mt-3' : ''
    ]"
    :inert="expanded ? undefined : true"
    :aria-hidden="expanded ? undefined : 'true'"
  >
    <div class="overflow-hidden">
      <USeparator size="xs">
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-arrow-up"
            class="size-3.5 text-primary"
          />
          <span class="text-sm text-primary">
            已同步 {{ props.count }} 条
          </span>
          <UButton
            label="查看"
            color="primary"
            variant="soft"
            size="xs"
            @click="handleApply"
          />
        </div>
      </USeparator>
    </div>

    <!--
      底部渐隐：从面板底色到「同色的全透明」的一条窄带，压在下面列表的顶上。滚动经过的
      内容在提示条下缘淡出，提示条就不再是「贴在内容上的一块硬边」。
      透明端写 /0 而不是 to-transparent：Tailwind v4 在 oklab 空间插值，白 → 透明黑会在
      中段泛灰，落成一层灰雾；同色透明才是干净的淡出。只盖内容不盖文字——它在提示条之外
      （top-full），且 pointer-events-none 不会挡住列表的点击。
    -->
    <div
      class="pointer-events-none absolute inset-x-0 top-full z-10 h-3 bg-linear-to-b from-[var(--ui-bg)] to-[var(--ui-bg)]/0"
      aria-hidden="true"
    />
  </div>
</template>
