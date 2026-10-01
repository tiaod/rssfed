<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RssEntry } from '~/types/rss'
import { DEFAULT_LIST_VIEW, type ListView } from '~/utils/listViews'
import { entryCoverAspect, IMAGE_TILE_FALLBACK_ASPECT } from '~/utils/entryDisplay'
// 显式导入：单测环境没有 Nuxt 组件清单，隐式解析会静默退化成「渲染不出来」
import EntryCardItem from '~/components/EntryCardItem.vue'
import EntryBlogItem from '~/components/EntryBlogItem.vue'
import EntryRowItem from '~/components/EntryRowItem.vue'
import EntryImageItem from '~/components/EntryImageItem.vue'

const props = defineProps<{
  entries: RssEntry[]
  /** 加载下一页数据的入口（带防重入）；不传时弹窗不预加载、也不显示页尾骨架 */
  loadMore?: () => unknown
  /** 是否还有更多条目可分页 */
  hasMore?: () => boolean
  /**
   * 署名用「所属订阅源」而不是条目作者（聚合视图用：时间线、分类页 —— 卡片来自多个源，
   * 先要知道是哪个源发的）。单源页不传这个 prop —— 源已经写在页面标题里，卡片上保留作者名更有信息量。
   */
  showFeed?: boolean
  /**
   * 是否把 `#header` 插槽当作列表首项渲染：页面级信息块（如单源页的订阅源描述）放进来，
   * 就会和条目一起滚动，而不是固定占住视图顶部。见下方 HeaderItem 的说明。
   */
  header?: boolean
  /**
   * 视口外上下各预渲染几个条目（不传时按列数算：至少 3，多列时约两行）。
   *
   * 注意它是「条目数」而不是「行数」——多列时同样的值只覆盖不到一行，所以默认值随列数放大。
   * 实测（390×900、连续滚动 85 帧）单列下 6 → 18 帧超过 20ms、3 → 4~5 帧、1 → 0~1 帧：
   * 掉帧基本都是「视口外多渲染出来的卡片」的布局成本，所以默认值往小里取。
   */
  overscan?: number
  /**
   * 列表版式。四种视图共用这一套虚拟化外壳（ScrollArea + 泳道虚拟化 + 页头 + 页尾骨架），
   * 只有 item 渲染与布局参数（列数 / 间距 / 高度估算）按视图切换。
   * 为什么不用 UBlogPosts / UPageList 当容器：见下面 VIEW_LAYOUT 的说明。
   */
  view?: ListView
}>()

/**
 * 列表项：真实条目、页尾加载骨架、以及「已加载全部」的收尾提示。
 * 三者都是虚拟化列表的 item，只渲染视口附近的那些。
 */
interface SkeletonItem {
  id: string
  skeleton: true
}

interface EndItem {
  id: string
  end: true
}

/**
 * 页头项（`#header` 插槽的内容）。
 *
 * 虚拟化把条目按泳道摆到各列，单个 item 无法跨列，所以页头按列数渲染同样多份：
 * 只有第一份可见并撑满整行宽度，其余 `invisible` 但同样占高 —— 于是每一列都从页头
 * 下方开始，视觉上就是一条贯穿整行的页头，而不是被挤进第一列的一个格子。
 */
interface HeaderItem {
  id: string
  header: true
}

/** 收尾项引用固定，避免每次渲染生成新对象把虚拟化测量打散 */
const endItem: EndItem = { id: '__list-end__', end: true }

type ListItem = RssEntry | SkeletonItem | HeaderItem | EndItem

function isSkeleton(item: ListItem): item is SkeletonItem {
  return 'skeleton' in item
}

function isEnd(item: ListItem): item is EndItem {
  return 'end' in item
}

function isHeader(item: ListItem): item is HeaderItem {
  return 'header' in item
}

/** 真条目（把占位项都排除掉，模板最后一段靠它收窄类型） */
function isEntry(item: ListItem): item is RssEntry {
  return !isSkeleton(item) && !isEnd(item) && !isHeader(item)
}

const showSkeleton = computed(() =>
  typeof props.loadMore === 'function' && (props.hasMore?.() ?? true)
)

const view = computed<ListView>(() => props.view ?? DEFAULT_LIST_VIEW)

/**
 * 各视图的列数断点表，与 app/assets/css/main.css 的 --breakpoint-3xl/4xl 及 Tailwind 默认断点一致。
 * 虚拟化必须由 JS 知道列数（lane 决定条目落哪一列），没法交给 CSS。按 minWidth 降序，首个命中生效。
 *
 * 列数刻意按视图分开：瀑布流在手机上也铺两列（卡片墙的密度感）；
 * 博客卡片要留大留白，手机单列、多列才在平板以上成立；
 * 紧凑列表永远单列；图片图块窄，手机上也放得下两列。
 */
const VIEW_BREAKPOINTS: Record<ListView, ReadonlyArray<readonly [number, number]>> = {
  // 瀑布流（图片/卡片墙）：手机上就给两列，卡片窄但信息密度高，和博客视图一眼能区分
  masonry: [
    [2560, 8], // 4xl
    [1792, 6], // 3xl
    [1536, 5], // 2xl
    [1280, 4], // xl
    [768, 3], // md（平板）
    [0, 2] // 手机
  ],
  // 博客视图：手机保持单列（卡片大、适合读），到平板/桌面才铺多列
  blog: [
    [1280, 3], // xl
    [768, 2], // md
    [0, 1]
  ],
  list: [[0, 1]],
  // 图片瀑布流：图块窄，手机上也能放两列
  image: [
    [1536, 5], // 2xl
    [1280, 4], // xl
    [1024, 3], // lg
    [0, 2]
  ]
}

/**
 * 各视图的条目间距（px）。
 *
 * 它同时是页头跨列宽度的换算依据（见 headerSpanStyle），所以不能写死在模板 class 里。
 * 列表视图间距为 0：行与行靠 border 分隔，留缝反而不像列表。
 */
const VIEW_GAP: Record<ListView, number> = {
  masonry: 16,
  blog: 24,
  list: 0,
  image: 8
}

const laneCount = ref(1)

function resolveLanes(width: number, target: ListView): number {
  for (const [minWidth, lanes] of VIEW_BREAKPOINTS[target]) {
    if (width >= minWidth) return lanes
  }
  return 1
}

const gap = computed(() => VIEW_GAP[view.value])

/**
 * 图片视图的单条泳道宽度（= 图块宽度）。
 *
 * estimateSize 只能拿到 index、拿不到容器宽度，所以自己量：ScrollArea 根节点宽度减去
 * 左右内边距，再按列数与间距均分。量不到（测试环境 / 还没挂载）时用兜底值，
 * 真实高度由虚拟化的逐项测量纠正。
 */
const IMAGE_LANE_WIDTH_FALLBACK = 160
const contentWidth = ref(0)

/** ScrollArea 根节点：既用来量内容宽度，也挂 ResizeObserver 跟随容器变化 */
const scrollAreaRef = ref<{ $el?: unknown } | null>(null)
let resizeObserver: ResizeObserver | null = null

function measureContentWidth() {
  const el = scrollAreaRef.value?.$el
  if (!(el instanceof HTMLElement)) return
  const style = window.getComputedStyle(el)
  const padding
    = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
  const width = el.clientWidth - padding
  if (width > 0 && width !== contentWidth.value) contentWidth.value = width
}

const imageLaneWidth = computed(() => {
  const width = contentWidth.value
  if (width <= 0) return IMAGE_LANE_WIDTH_FALLBACK
  const lanes = Math.max(1, laneCount.value)
  return Math.max(96, Math.floor((width - (lanes - 1) * gap.value) / lanes))
})

/**
 * 图片视图的图块高度：按封面真实宽高比换算（与 EntryImageItem 的 aspect-ratio 同一口径）。
 *
 * 有封面但缺尺寸元信息、以及没有封面的条目，都按 4:3 兜底 —— 和组件渲染出来的高度一致，
 * 泳道分配才不会因为估算离谱而参差。
 */
function imageTileHeight(entry: RssEntry | undefined): number {
  const aspect = entry ? entryCoverAspect(entry) : null
  return Math.round(imageLaneWidth.value / (aspect ?? IMAGE_TILE_FALLBACK_ASPECT))
}

/**
 * 页尾加载骨架：**每列一个**。
 *
 * 骨架在这里身兼两职：一是「滚动到底」的触发信号（见下面的 useIntersectionObserver），
 * 二是各列的尾巴——列数等于骨架数，虚拟化按「最矮泳道」分配，N 个等高的骨架必然一列落一个，
 * 于是滚到底部时每一列都有东西，不会露出「矮列早早结束」的空白，也就不再需要列尾补平。
 * 用 id 稳定 key，虚拟化测量不会因为重新渲染而丢。
 */
const skeletonItems = computed<SkeletonItem[]>(() =>
  Array.from({ length: Math.max(1, laneCount.value) }, (_, i) => ({
    id: `__loading-skeleton-${i}`,
    skeleton: true as const
  }))
)

/** 页头项：每列一份，id 稳定，虚拟化测量不会因为重渲染而丢 */
const headerItems = computed<HeaderItem[]>(() =>
  props.header
    ? Array.from({ length: Math.max(1, laneCount.value) }, (_, i) => ({
        id: `__list-header-${i}`,
        header: true as const
      }))
    : []
)

/** 页头跨列宽度：item 的宽度是「一列」，这里按列数与间隙换算回整行宽度 */
const headerSpanStyle = computed(() => ({
  inlineSize: `calc(${laneCount.value} * 100% + ${(laneCount.value - 1) * gap.value}px)`
}))

/** 交给虚拟化的是「页头 + 真实条目 + 每列一个页尾骨架」（或收尾提示） */
const listItems = computed<ListItem[]>(() => {
  if (!props.entries.length) return []
  const tail = showSkeleton.value ? skeletonItems.value : [endItem]
  return [...headerItems.value, ...props.entries, ...tail]
})

function handleResize() {
  const next = resolveLanes(window.innerWidth, view.value)
  if (next !== laneCount.value) laneCount.value = next
}

/**
 * 量一次容器宽度并（重新）挂上 ResizeObserver。
 *
 * 必须可重入：切视图会 `:key="view"` 重建 ScrollArea，旧元素已从文档里摘掉，
 * 继续观察它等于永远不再收到回调 —— 图片瀑布流的泳道宽度会停在切换前那一版。
 */
async function syncViewportMeasurement() {
  await nextTick()
  const el = scrollAreaRef.value?.$el
  resizeObserver?.disconnect()
  resizeObserver = null
  measureContentWidth()
  if (el instanceof HTMLElement && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => measureContentWidth())
    resizeObserver.observe(el)
  }
}

onMounted(() => {
  laneCount.value = resolveLanes(window.innerWidth, view.value)
  window.addEventListener('resize', handleResize)

  // 图片瀑布流的泳道宽度依赖容器宽度：先量一次，再用 ResizeObserver 跟随侧边栏 / 窗口变化
  void syncViewportMeasurement()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  resizeObserver?.disconnect()
  resizeObserver = null
})

/**
 * 博客卡片的估算高度。
 *
 * 多列时卡片写死等高（`sm:h-[22rem]`，见 EntryBlogItem），估算值就是真实高度，泳道分配才排得整齐；
 * 手机单列没有行要对齐，卡片不再强制等高、没有封面的条目也不再有那条 144px 占位带，
 * 于是估算按「有封面 / 无封面」分开给，总高度和滚动条才不会虚高。
 * （单列正是 `laneCount === 1`，与 blog 的断点表同源，不用再判断一次屏宽。）
 */
function blogEstimateHeight(entry: RssEntry | undefined): number {
  if (laneCount.value > 1) return 352
  return entry?.coverUrl ? 336 : 192
}

/**
 * 单条高度估算（px），只用于还没被测量过的条目；渲染过一次后 ScrollArea 内部会记住真实高度。
 *
 * 每个视图的估算口径都和它实际渲染出来的高度对齐（瀑布流：有封面的按 min-h-40 起算；
 * 博客：多列写死卡片高、单列按有无封面分档；列表：写死 h-24；图片：按封面宽高比换算），
 * 这样总高度和滚动条不会因为估算离谱而抖动。
 */
function estimateHeight(item: ListItem | undefined): number {
  if (!item || isEnd(item)) return 72
  if (isHeader(item)) return 96
  if (isSkeleton(item)) {
    switch (view.value) {
      case 'blog': return blogEstimateHeight(undefined)
      case 'list': return 96
      case 'image': return imageTileHeight(undefined)
      default: return 280
    }
  }
  switch (view.value) {
    case 'blog': return blogEstimateHeight(isEntry(item) ? item : undefined)
    case 'list': return 96
    // 图片视图是瀑布流：每条按自己封面的宽高比算高度（见 EntryImageItem）
    case 'image': return imageTileHeight(isEntry(item) ? item : undefined)
    default: return item.coverUrl ? 320 : 180
  }
}

/**
 * 交给 ScrollArea 的虚拟化配置。
 *
 * 列尾参差这件事在虚拟化下没法像以前那样补：条目落哪一列、摆在哪里，都是 tanstack 内部
 * 按「最矮泳道 + 估算高度」算的，没有公开 API 能把高位列尾部的条目挪到矮列（试过
 * `laneAssignmentMode: 'measured'`，实测无改善：参差 321px → 370px，它只是不缓存 lane，
 * 重算用的仍是同一批估算值）。
 *
 * 好在窄屏（手机，本项目的主场景）瀑布流只有 1 列，本来就不存在列尾参差；多列只出现在
 * 平板/桌面，那里设备性能充裕，参差约一张卡片高，不影响阅读。
 * 博客视图的卡片高度本就接近一致，同样按泳道摆放出来就是规整的网格。
 */
const virtualize = computed(() => ({
  lanes: laneCount.value,
  gap: gap.value,
  overscan: props.overscan ?? Math.max(3, laneCount.value * 2),
  /**
   * 滚动区铺满整个面板（页面的 body 已经 p-0），内边距改由这里承担，滚动条才会像以前那样
   * 贴面板右边缘，而不是缩在中间一块。垂直方向用 virtualize 的 paddingStart/End，
   * 水平方向用 ScrollArea 自己的 padding。
   */
  paddingStart: 16,
  paddingEnd: 16,
  estimateSize: (index: number) => estimateHeight(listItems.value[index])
}))

/**
 * 页尾骨架就是触底信号：任一骨架进入视口就加载下一批。
 *
 * 不用「提前 N 屏预加载」：IntersectionObserver 的相交判定还要与 target 的所有滚动祖先裁剪框
 * 求交，骨架可见这个信号本身就在容器可视区内，最省事也最可靠。
 */
const skeletonEls = ref<HTMLElement[]>([])

function registerSkeleton(el: Element | ComponentPublicInstance | null) {
  if (!(el instanceof HTMLElement) || skeletonEls.value.includes(el)) return
  skeletonEls.value = [...skeletonEls.value, el]
}

// 各视图的断点表不同，切视图要按新表重算列数；ScrollArea 会重建，测量目标也要重新挂
watch(view, () => {
  handleResize()
  void syncViewportMeasurement()
  // 旧视图的骨架元素已随 ScrollArea 重建卸载，清掉避免 observer 继续盯着脱离文档的节点
  skeletonEls.value = []
})

useIntersectionObserver(
  skeletonEls,
  (intersections) => {
    if (intersections.some(entry => entry.isIntersecting)) void props.loadMore?.()
  },
  { rootMargin: '0px 0px 200px 0px' }
)

const { openEntry } = useEntryModal()

// 打开详情时传入当前可见列表（取值函数而非快照），modal 内的上一篇/下一篇沿此定位
function handleOpen(entry: RssEntry) {
  openEntry(
    entry,
    () => props.entries,
    // 列表支持分页才注入加载上下文；否则保持纯静态快照行为
    props.loadMore ? { loadMore: props.loadMore, hasMore: props.hasMore ?? (() => true) } : undefined
  )
}
</script>

<template>
  <!--
    列表虚拟化交给 Nuxt UI 的 ScrollArea（内部就是 @tanstack/vue-virtual 的官方封装）：
    只渲染视口附近的条目。手机上条目一多，每追加一批都要重新布局整棵已有 DOM
    （实测 1200 条时一次长任务 133ms），虚拟化后 DOM 数量与总条数无关。
    它自带滚动容器，所以外层容器要给它确定高度（页面里是 flex-1 + min-h-0）。

    四种视图都走这一套外壳，只是 row 渲染与布局参数不同：UBlogPosts / UPageList 都是
    「数组 -> 一整块 DOM」的容器，套不进「index -> 一个块」的虚拟化 slot（见 view prop 说明）。
    切视图会重建 ScrollArea（:key）：布局算法换了，重建比让旧虚拟化缓存里残留上一版
    的测量值更干净；代价是滚动位置回到顶部，而这正是切换视图时用户预期的位置。
  -->
  <UScrollArea
    ref="scrollAreaRef"
    :key="view"
    :items="listItems"
    :virtualize="virtualize"
    class="h-full"
    :ui="{ root: 'h-full px-4 sm:px-6' }"
  >
    <template #default="{ item, index }">
      <!--
        页头：只有第一份可见，其余同内容的副本 invisible 占位（见 HeaderItem 说明），
        宽度都按整行算，各列高度才一致、条目才会从页头下方整齐开始。
      -->
      <div
        v-if="isHeader(item)"
        :style="headerSpanStyle"
        :class="index === 0 ? undefined : 'invisible'"
        :aria-hidden="index === 0 ? undefined : 'true'"
      >
        <slot name="header" />
      </div>

      <!-- 页尾加载骨架 -->
      <div
        v-else-if="isSkeleton(item)"
        :ref="registerSkeleton"
        class="flex flex-col gap-3"
        aria-hidden="true"
      >
        <USkeleton class="h-40 w-full rounded-lg" />
        <USkeleton class="h-4 w-3/4" />
        <USkeleton class="mt-0 h-4 w-1/2" />
      </div>

      <!-- 收尾提示 -->
      <p
        v-else-if="isEnd(item)"
        class="py-6 text-center text-xs text-muted"
      >
        已加载全部条目
      </p>

      <EntryBlogItem
        v-else-if="isEntry(item) && view === 'blog'"
        :key="item.id"
        :entry="item"
        :show-feed="showFeed"
        @open="handleOpen"
      />

      <EntryRowItem
        v-else-if="isEntry(item) && view === 'list'"
        :key="item.id"
        :entry="item"
        :show-feed="showFeed"
        @open="handleOpen"
      />

      <EntryImageItem
        v-else-if="isEntry(item) && view === 'image'"
        :key="item.id"
        :entry="item"
        @open="handleOpen"
      />

      <EntryCardItem
        v-else-if="isEntry(item)"
        :key="item.id"
        :entry="item"
        :show-feed="showFeed"
        @open="handleOpen"
      />
    </template>
  </UScrollArea>
</template>
