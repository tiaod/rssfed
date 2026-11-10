<script setup lang="ts">
/**
 * 列表首屏骨架：加载中的占位，**按视图还原条目的版式**。
 *
 * 为什么要有它（而不是一个转圈）：列表的首屏要么本地查询还没回来、要么在等优先同步，
 * 这段时间屏幕上只有导航栏和一个转圈，用户不知道下面会出来什么、也不知道出来了会不会
 * 被顶走。骨架先把「这里将出现 N 条、什么版式」画出来，加载完成后原地替换，页面不会跳版。
 *
 * 为什么尺寸必须对得上：骨架的价值全在「替换上去不跳动」。因此它不自己发明一套尺寸，而是
 * 复用真实列表的口径 ——
 *   - 列数 / 间距：`utils/listViewLayout`（与 EntryList 的泳道虚拟化同一张断点表）；
 *   - 单条高度：EntryList.estimateHeight 的各视图分档（见下面逐个常量）；
 *   - 外边距：ScrollArea 根节点的 `px-4 sm:px-6` + 虚拟化的上下 padding 16
 *     （表格视图例外：它不用 ScrollArea，内边距由单元格自己的 px-4 提供）。
 * 两处各写一套数字，改一处忘一处就会出现「骨架铺三列、条目铺两列」，而这正是本组件要避免的。
 *
 * 只渲染一屏、不做虚拟化、也不滚动：骨架存在的时间是几百毫秒，多出来的部分被
 * `overflow-hidden` 裁掉即可 —— 为它接一套虚拟化，复杂度全落在了看不见的地方。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DEFAULT_LIST_VIEW, type ListView } from '~/utils/listViews'
import { resolveLanes, TABLE_ROW_HEIGHT, VIEW_GAP } from '~/utils/listViewLayout'
import { IMAGE_TILE_FALLBACK_ASPECT } from '~/utils/entryDisplay'

const props = withDefaults(defineProps<{
  /**
   * 要还原的版式。必须传**页面当前生效的那个视图**（不是全局默认值）：
   * 传错了骨架就与随后渲染出来的条目版式对不上，替换时照样跳版。
   */
  view?: ListView
  /** 画多少条。默认 6：手机单列下够铺满一屏多一点，多列视图里也够排两行以上 */
  count?: number
  /**
   * 聚合视图（时间线 / 分类页）：署名是订阅源名而不是条目作者。
   *
   * 骨架画不出文字，但它决定署名行那条占位块的宽度 —— 源名普遍比作者名长，
   * 宽度对上了，替换时右侧的时间 / 未读圆点才不会横跳。
   */
  showFeed?: boolean
}>(), {
  view: DEFAULT_LIST_VIEW,
  count: 6,
  showFeed: false
})

/**
 * 社交动态单条的估算高度（= EntryList.socialEstimateHeight 的「文字档」170）。
 *
 * 170 是实测值：作者行 + 一行标题 + 两行摘要 + 操作栏。取它而不是只让内容自撑高度：
 * 骨架的内部块加起来只有 ~118，不补这一档的话整条会矮 50px 左右，替换上去可见跳版。
 * 带图片的条目比这更高，但首屏里绝大多数是纯文字条目，按文字档排最接近。
 */
const SOCIAL_ITEM_HEIGHT = 170

/** 列表视图行高 = EntryRowItem 的 `h-24`（写死 96 是列表视图的前提：行高一致才整齐） */
const LIST_ROW_HEIGHT = 96

/** 博客多列卡片高 = EntryBlogItem 的 `h-[22rem]` = EntryList.blogEstimateHeight 的多列档 352 */
const BLOG_CARD_HEIGHT = 352

/**
 * 博客单列（有封面）档 = EntryList.blogEstimateHeight 的单列有封面 336。
 * 单列不强制等高，高度交回内容；骨架一律按「有封面」排 —— 封面是博客卡片的常态，
 * 且这一档正好也是封面带 144 + 文字区撑起来的高度。
 */
const BLOG_SINGLE_CARD_HEIGHT = 336

/** 博客封面带高度：EntryBlogItem 的 `h-36`（144） */
const BLOG_COVER_HEIGHT = 144

/**
 * 当前列数：按 window.innerWidth 从断点表解析，与 EntryList 的 laneCount 完全同源。
 *
 * 初值取 1 而不是「先算一次 window」：SSR / 首帧两侧都必须得到同一个值，否则 hydration
 * 一上来就对不上（EntryList 也是这个口径：挂载后才解析，再挂 resize 跟随）。
 */
const lanes = ref(1)

/** 多列视图的网格：列数与间距都来自共享的断点表，不写 CSS 断点 */
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${lanes.value}, minmax(0, 1fr))`,
  gap: `${VIEW_GAP[props.view]}px`
}))

/** 按当前视图铺几列（表格 / 列表 / 社交动态恒为单列，读了也没用，但让逻辑只有一份） */
function syncLanes() {
  lanes.value = resolveLanes(window.innerWidth, props.view)
}

onMounted(() => {
  syncLanes()
  window.addEventListener('resize', syncLanes)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncLanes)
})

// 页面可能在首屏加载期间切视图（切换按钮不被 loading 挡住）：断点表换了，列数要跟着换
watch(() => props.view, syncLanes)

/** 占位条目数：count 是外部输入，夹一下避免负数 / 小数造出奇怪的循环 */
const items = computed(() => Array.from({ length: Math.max(0, Math.floor(props.count)) }, (_, i) => i + 1))
</script>

<template>
  <div
    class="h-full overflow-hidden"
    :class="view === 'table' ? undefined : 'px-4 py-4 sm:px-6'"
    aria-busy="true"
  >
    <!--
      根节点必须是**单根**，且模板第一行不能是注释：Vue 只在单根时自动继承属性，而根上哪怕
      只留一句模板注释，整棵树就变成 fragment、`min-h-0 flex-1` 直接丢掉（页面靠它决定高度）。
      这也是为什么这段说明写在这里而不是模板顶部。

      左右内边距对齐 ScrollArea 根节点的 `px-4 sm:px-6`、上下对齐虚拟化的 paddingStart/End 16，
      骨架的第一条才和条目从同一个位置开始 —— 表格视图例外（它不走 ScrollArea，内边距由单元格
      自己的 px-4 提供），多给一层只会让列头比真实表格缩进一格。
    -->
    <!-- 对读屏只报一句「在加载」，并让它们等这一批占位结束后再读 -->
    <p
      class="sr-only"
      role="status"
    >
      正在加载条目…
    </p>

    <!--
      下面整棵占位树对读屏隐藏。USkeleton 自己带 role="alert" + aria-label="loading"，
      一屏几十个占位块会让读屏念几十遍「loading」—— 加载这件事由上面那一句说一次就够了。
    -->
    <div aria-hidden="true">
      <!-- 社交动态：四段（头像圈 / 署名行 + 标题 + 两行摘要 / 操作栏）+ 底部分隔线，与 EntrySocialItem 同一套尺寸 -->
      <div
        v-if="view === 'social'"
        class="flex flex-col"
      >
        <div
          v-for="i in items"
          :key="i"
          class="mx-auto flex w-full max-w-xl flex-col border-b border-default/60 py-4"
          :style="{ minHeight: `${SOCIAL_ITEM_HEIGHT}px` }"
        >
          <div class="flex items-start gap-2">
            <USkeleton class="size-8 shrink-0 rounded-full" />
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <USkeleton
                class="h-3.5"
                :class="showFeed ? 'w-28' : 'w-20'"
              />
              <USkeleton class="h-4 w-3/4" />
              <USkeleton class="h-3.5 w-full" />
              <USkeleton class="h-3.5 w-4/5" />
              <div class="flex items-center gap-1">
                <USkeleton class="size-7 rounded-md" />
                <USkeleton class="size-7 rounded-md" />
                <USkeleton class="size-7 rounded-md" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 瀑布流：卡片墙。手机就两列（与断点表一致），卡片沿用列表页尾骨架的「封面 + 两行文字」形状 -->
      <div
        v-else-if="view === 'masonry'"
        class="grid items-start"
        :style="gridStyle"
      >
        <div
          v-for="i in items"
          :key="i"
          class="flex flex-col gap-3"
        >
          <USkeleton class="h-40 w-full rounded-lg" />
          <USkeleton class="h-4 w-3/4" />
          <USkeleton class="h-4 w-1/2" />
        </div>
      </div>

      <!-- 博客文章：封面压成横条 + 两行文字，多列时与条目一样写死等高（352） -->
      <div
        v-else-if="view === 'blog'"
        class="grid"
        :style="gridStyle"
      >
        <div
          v-for="i in items"
          :key="i"
          class="flex flex-col overflow-hidden rounded-lg"
          :style="{ minHeight: `${lanes > 1 ? BLOG_CARD_HEIGHT : BLOG_SINGLE_CARD_HEIGHT}px` }"
        >
          <USkeleton
            class="w-full shrink-0 rounded-none"
            :style="{ height: `${BLOG_COVER_HEIGHT}px` }"
          />
          <div class="flex flex-1 flex-col gap-2 p-4 sm:p-6">
            <USkeleton class="h-4 w-3/4" />
            <USkeleton class="h-3.5 w-full" />
            <USkeleton class="h-3.5 w-5/6" />
            <!-- 署名行贴底：真实卡片的 authors 是 mt-auto，不贴底的话替换时它会往下跳 -->
            <USkeleton class="mt-auto h-3 w-1/3" />
          </div>
        </div>
      </div>

      <!-- 列表：紧凑单行（缩略图 + 标题 + 两行摘要），行高与 EntryRowItem 的 h-24 一致 -->
      <div
        v-else-if="view === 'list'"
        class="flex flex-col"
      >
        <div
          v-for="i in items"
          :key="i"
          class="flex items-center gap-3 border-b border-default/60"
          :style="{ height: `${LIST_ROW_HEIGHT}px` }"
        >
          <USkeleton class="size-16 shrink-0 rounded-md" />
          <div class="min-w-0 flex-1">
            <USkeleton class="h-3.5 w-2/3" />
            <USkeleton class="mt-2 h-3 w-full" />
            <USkeleton class="mt-1.5 h-3 w-1/3" />
          </div>
        </div>
      </div>

      <!-- 图片：按 4:3 兜底比例占位的图块墙（真实条目按封面比例，比例元信息还没到时也是 4:3） -->
      <div
        v-else-if="view === 'image'"
        class="grid"
        :style="gridStyle"
      >
        <USkeleton
          v-for="i in items"
          :key="i"
          class="w-full rounded-lg"
          :style="{ aspectRatio: String(IMAGE_TILE_FALLBACK_ASPECT) }"
        />
      </div>

      <!--
        表格：一行一条（来源 / 标题 / 时间），行高与 TABLE_ROW_HEIGHT 一致。
        列宽照抄 EntryList.tableColumns 的 th（窄屏收窄、sm: 还原），列头也跟着画一条 ——
        真实表格的 thead 是 sticky 的，骨架不画它，替换瞬间所有行会整体上移一行。
      -->
      <div
        v-else
        class="flex flex-col"
      >
        <div class="flex h-12 items-center gap-4 border-b border-default px-4">
          <USkeleton class="h-3 w-20 shrink-0 sm:w-48" />
          <USkeleton class="h-3 min-w-0 flex-1" />
          <USkeleton class="h-3 w-24 shrink-0 sm:w-28" />
        </div>
        <div
          v-for="i in items"
          :key="i"
          class="flex items-center gap-4 border-b border-default px-4"
          :style="{ height: `${TABLE_ROW_HEIGHT}px` }"
        >
          <USkeleton class="h-3.5 w-20 shrink-0 sm:w-48" />
          <USkeleton class="h-3.5 min-w-0 flex-1" />
          <USkeleton class="h-3.5 w-24 shrink-0 sm:w-28" />
        </div>
      </div>
    </div>
  </div>
</template>
