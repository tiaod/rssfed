<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { RssEntry } from '~/types/rss'
import { DEFAULT_LIST_VIEW, type ListView } from '~/utils/listViews'
import {
  entryByline,
  entryCoverAspect,
  entryDate,
  entryExcerpt,
  entryFeedImages,
  entryFeedName,
  feedImagesHeight,
  FEED_COLUMN_MAX,
  FEED_CONTENT_INDENT,
  IMAGE_TILE_FALLBACK_ASPECT
} from '~/utils/entryDisplay'
// 显式导入：单测环境没有 Nuxt 组件清单，隐式解析会静默退化成「渲染不出来」
import EntryCardItem from '~/components/EntryCardItem.vue'
import EntryBlogItem from '~/components/EntryBlogItem.vue'
import EntryRowItem from '~/components/EntryRowItem.vue'
import EntryImageItem from '~/components/EntryImageItem.vue'
import EntrySocialItem from '~/components/EntrySocialItem.vue'

/**
 * 自己转发 $attrs：模板是 ScrollArea / Table 两个分支，Vue 对「多根节点」不再自动继承
 * 属性，页面给的 `flex-1 min-h-0` 会当场丢掉（两种分支机构都靠它拿到确定高度）。
 */
defineOptions({ inheritAttrs: false })

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
   * 视口外上下各预渲染几个条目（不传时按列数算：至少 3，多列时约两行；表格视图按 8 行）。
   *
   * 注意它是「条目数」而不是「行数」——多列时同样的值只覆盖不到一行，所以默认值随列数放大。
   * 实测（390×900、连续滚动 85 帧）单列下 6 → 18 帧超过 20ms、3 → 4~5 帧、1 → 0~1 帧：
   * 掉帧基本都是「视口外多渲染出来的卡片」的布局成本，所以默认值往小里取。
   */
  overscan?: number
  /**
   * 列表版式。除「表格」外的四种视图共用这一套虚拟化外壳（ScrollArea + 泳道虚拟化 +
   * 页头 + 页尾骨架），只有 item 渲染与布局参数（列数 / 间距 / 高度估算）按视图切换；
   * 表格走 Nuxt UI 的 Table（自带 virtualize），见 TABLE_ROW_HEIGHT 那段说明。
   * 为什么不用 UBlogPosts / UPageList 当容器：见下面 VIEW_BREAKPOINTS 的说明。
   */
  view?: ListView
  /**
   * 有它时「打开」只改地址，详情交给页面按路由参数打开（单源页的
   * `/rss/feed/:id/entry/:entryId`）。不传则维持原行为：直接开全局弹窗。
   *
   * 地址与详情是同一件事的两面，谁先谁后不能各写一套：传了它就只走地址这一条路。
   */
  entryLink?: (entry: RssEntry) => string
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
  // 社交动态：手机与桌面都是同一条窄列（条目内部再居中限宽），列数恒定不影响断点
  social: [[0, 1]],
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
  // 表格恒为单列，且走的是 Table 分支（不用泳道虚拟化）：这里只为枚举完整、不参与布局
  table: [[0, 1]],
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
  social: 0, // 条与条靠分隔线划分，留缝就不像信息流了
  masonry: 16,
  blog: 24,
  list: 0,
  table: 0, // 同上：表格分支不吃这个值
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

/**
 * 虚拟化实例里本组件用到的最小面（见 revealEntry 的定位说明）。
 *
 * 只借它**算**目标位置，不用它的 scrollToIndex：那条路（见 glideScroll 的说明）实测一卡一卡。
 * `getOffsetForIndex(index, align)` 返回 `[偏移, align]`，偏移已按视口居中并夹在可滚范围内。
 */
interface EntryVirtualizer {
  getOffsetForIndex?: (
    index: number,
    align?: 'start' | 'center' | 'end' | 'auto'
  ) => [number, string] | undefined
}

/** ScrollArea 对外暴露的东西：根节点（量宽度 / 当滚动容器）与虚拟化实例 */
interface ScrollAreaExposed {
  $el?: unknown
  virtualizer?: EntryVirtualizer | null
}

/**
 * ScrollArea 根节点：既用来量内容宽度，也挂 ResizeObserver 跟随容器变化；
 * 关闭详情后的「拉回视野」还用它暴露的虚拟化实例估算目标位置（见 revealEntry）。
 */
const scrollAreaRef = ref<ScrollAreaExposed | null>(null)

/** 表格分支的根节点：UTable 自己就是滚动容器，关闭详情后同样要能滚到那一条 */
const tableRef = ref<{ $el?: unknown } | null>(null)
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
 * 单列（`laneCount === 1`，与 blog 断点表同源）没有行要对齐，卡片不强制等高、没有封面的条目
 * 也不再有那条 144px 占位带，于是估算按「有封面 / 无封面」分开给，总高度和滚动条才不会虚高。
 */
function blogEstimateHeight(entry: RssEntry | undefined): number {
  if (laneCount.value > 1) return 352
  return entry?.coverUrl ? 336 : 192
}

/**
 * 社交动态条目的估算高度。
 *
 * 单列，估不准只牵连总高度与滚动条（没有泳道要对齐），所以按「文字档 + 图片区」两段给：
 * 文字档 170（作者行 + 一行标题 + 两行摘要 + 操作栏，实测），图片区与图片视图同一口径 ——
 * 单图按夹好的比例与高度上限算，多图按行数 × (列宽 / 3) 算（见 utils/entryDisplay.ts 的
 * feedImagesHeight）。注意图片区在**正文列**里：列宽要先减掉头像那一栏（FEED_CONTENT_INDENT）。
 */
function socialEstimateHeight(entry: RssEntry | undefined): number {
  const text = 170
  const outer = contentWidth.value > 0 ? Math.min(contentWidth.value, FEED_COLUMN_MAX) : FEED_COLUMN_MAX
  const column = Math.max(0, outer - FEED_CONTENT_INDENT)
  const media = entry ? feedImagesHeight(entryFeedImages(entry), column) : 0
  return media ? text + 8 + media : text // +8 = 文字与图片之间的 gap-2
}

/**
 * 单条高度估算（px），只用于还没被测量过的条目；渲染过一次后 ScrollArea 内部会记住真实高度。
 *
 * 每个视图的估算口径都和它实际渲染出来的高度对齐（瀑布流：有封面的按 min-h-40 起算；
 * 博客：多列写死卡片高、单列按有无封面分档；列表：写死 h-24；图片与社交动态：按封面宽高比换算），
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
      case 'social': return socialEstimateHeight(undefined)
      default: return 280
    }
  }
  switch (view.value) {
    case 'blog': return blogEstimateHeight(isEntry(item) ? item : undefined)
    case 'list': return 96
    // 图片视图是瀑布流：每条按自己封面的宽高比算高度（见 EntryImageItem）
    case 'image': return imageTileHeight(isEntry(item) ? item : undefined)
    case 'social': return socialEstimateHeight(isEntry(item) ? item : undefined)
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

const { openEntry, isOpen, currentEntry, navigatedInDetail } = useEntryModal()

/**
 * 详情正在展示的那条，列表里给它一圈高亮。
 *
 * 宽屏三栏下正文在右侧、列表在中间，没有这个标记就不知道右边这篇对应左边哪一行；
 * 详情没打开时（窄屏关掉弹窗、宽屏点关闭）没有选中项。
 */
const selectedId = computed(() => (isOpen.value ? currentEntry.value?.id ?? null : null))

// 打开详情时传入当前可见列表（取值函数而非快照），modal 内的上一篇/下一篇沿此定位
function handleOpen(entry: RssEntry) {
  // 页面把地址作为详情的唯一真源（单源页）：先导航，详情由页面的路由监听打开 ——
  // 这里不能再顺手 openEntry，否则地址与详情各走各的，返回键就没人管了
  if (props.entryLink) {
    void navigateTo(props.entryLink(entry))
    return
  }
  openEntry(
    entry,
    () => props.entries,
    // 列表支持分页才注入加载上下文；否则保持纯静态快照行为
    props.loadMore ? { loadMore: props.loadMore, hasMore: props.hasMore ?? (() => true) } : undefined
  )
}

// ── 关闭详情后把「刚刚在读的那一条」拉回视野 ──────────────────────────────

/**
 * 「闪一下」的时长（毫秒）。
 *
 * 与 main.css 里 entry-flash 动画（1.4s）配一对：动画自己会淡出，这个定时器只负责把触发标记
 * 摘掉 —— 标记留着的话动画早跑完了、元素却还挂着那份高亮，看上去就像多出来一个选中态，
 * 而且同一条下次也触发不了（属性值没变，Vue 不会重贴，动画自然不重放）。
 */
const REVEAL_FLASH_MS = 1500

/**
 * 定位动画的时间常数（毫秒）与兜底上限。
 *
 * 每帧走掉剩余距离的 dt/TAU：速度自带「起步快、末段缓」，帧率变了只影响步长，不会变成跳。
 * 120ms 下第一帧约走 14%（按下面的瞬移上限折算，单帧约 120px，也就是 7 千像素/秒上下），
 * 可见的那一段约 0.4s，末段是亚像素级的收敛（看不出来）。1.6s 都没收敛就交出去 ——
 * 落点对不对由 revealEntry 再看一眼，它宁可再滑一轮也不在这里硬凑。
 */
const REVEAL_GLIDE_TAU_MS = 120
const REVEAL_GLIDE_TIMEOUT_MS = 1600

/** 剩余距离小于它就算到了（指数收敛永远差一点点，别为半个像素一直转） */
const REVEAL_GLIDE_MIN_STEP_PX = 1.5

/**
 * 超过「这么多屏」就先瞬移掉大部分，只留最后一屏多给动画。
 *
 * **这是实测确认过、要保留的取舍**：几万像素要么慢得要走一分钟，要么快得整屏糊成一片 —— 两种都
 * 不是「滑过去」，只是把等待摊长了。用户复测后的原话是「这样的速度反而更快，就现在这个效果就可以，
 * 不用全程飞过去」。所以：瞬移一帧（这一帧和关闭详情同一瞬间，眼睛还在详情上）+ 最后一屏多的连续
 * 滑行（约 0.4s），最后这一屏多才是唯一看得清「从哪来、到哪去」的一段。
 * 以后要动这段，请连这条决定一起改，别顺手换成全程动画。
 *
 * 1.2 屏是按下面的时间常数反推的：第一帧走剩余距离的 dt/TAU ≈ 14%，乘一屏多 ≈ 120px/帧
 * （约 7 千像素/秒）；再拉长，第一帧就成「一下子糊过去」了。
 */
const REVEAL_TELEPORT_VIEWPORTS = 1.2
const REVEAL_TELEPORT_MIN_PX = 320

/** 正在跑的定位动画；重开一次定位、或者定位变成不需要滚动时要把它停掉 */
let stopGliding: (() => void) | null = null

onBeforeUnmount(() => {
  clearTimeout(flashTimer)
  stopGliding?.()
})

/**
 * 朝目标滑过去 —— 自己逐帧推，**不走虚拟化实例的 scrollToIndex({ behavior: 'smooth' })**。
 *
 * 那条路实测是一卡一卡的：@tanstack/virtual-core 的 reconcileScroll 每帧按最新测量值重算目标、
 * 距离掉到一屏以内就把 behavior 改成 'auto' 一步跳到位，itemSize 变化时的 applyScrollAdjustment
 * 也是瞬时校正。一段 1.6 万像素的定位里 362 帧只有 114 帧在动，单帧最大位移 766px（整整一屏）。
 * 自己推就只有一条连续曲线：目标每帧重算（虚拟化边滚边量，落点会变），但每帧只走剩余距离的一小步，
 * 读的是**实时位置**而不是「旧起点」—— 这样中间那次瞬时校正（内容不动的位移）也能跟着走，
 * 不会被下一帧顶回去。
 */
function glideScroll(scroller: HTMLElement, readTarget: () => number | null, done: () => void) {
  stopGliding?.()

  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const clamp = (value: number) => Math.min(Math.max(value, 0), max)
  const first = readTarget()
  if (first === null) {
    done()
    return
  }

  // 远距离先瞬移，只留最后一屏多给动画（为什么这么取舍，见 REVEAL_TELEPORT_VIEWPORTS 的说明）
  const target = clamp(first)
  const keep = Math.max(scroller.clientHeight * REVEAL_TELEPORT_VIEWPORTS, REVEAL_TELEPORT_MIN_PX)
  if (Math.abs(target - scroller.scrollTop) > keep) {
    scroller.scrollTop = clamp(target - Math.sign(target - scroller.scrollTop) * keep)
  }

  const startedAt = performance.now()
  let last = startedAt
  let frame = 0
  // 位置连着两帧没往前走（剩下不足半像素，被设备像素取整吃掉）：收尾对齐，别耗到超时
  let stalled = 0
  let ticks = 0

  const stop = () => {
    cancelAnimationFrame(frame)
    if (stopGliding === stop) stopGliding = null
  }

  const tick = () => {
    const now = performance.now()
    const dt = Math.min(now - last, 64) // 掉帧时别一步跨太远
    last = now
    ticks += 1
    const to = clamp(readTarget() ?? target)
    const current = scroller.scrollTop
    const delta = to - current
    if (Math.abs(delta) <= REVEAL_GLIDE_MIN_STEP_PX || now - startedAt > REVEAL_GLIDE_TIMEOUT_MS) {
      if (Math.abs(delta) <= REVEAL_GLIDE_MIN_STEP_PX) scroller.scrollTop = to
      stop()
      done()
      return
    }
    scroller.scrollTop = current + delta * Math.min(1, dt / REVEAL_GLIDE_TAU_MS)
    // 位置没往前走（剩下不足半像素，被设备像素取整吃掉）：别再耗着，收尾对齐到目标
    stalled = Math.abs(scroller.scrollTop - current) < 0.5 ? stalled + 1 : 0
    if (ticks > 2 && stalled >= 2) {
      scroller.scrollTop = to
      stop()
      done()
      return
    }
    frame = requestAnimationFrame(tick)
  }

  stopGliding = stop
  frame = requestAnimationFrame(tick)
}

/** 正在闪的那一条；滚动区的条目看 data-flash 属性，表格的行看 entry-flash 类（见 tableMeta） */
const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

function flashEntry(id: string) {
  clearTimeout(flashTimer)
  flashId.value = id
  flashTimer = setTimeout(() => {
    flashId.value = null
  }, REVEAL_FLASH_MS)
}

/** 当前列表的滚动容器根节点：表格分支是 UTable 自己的根，其余视图是 ScrollArea 的根 */
function revealRoot(): HTMLElement | null {
  const exposed = view.value === 'table' ? tableRef.value : scrollAreaRef.value
  const el = exposed?.$el
  return el instanceof HTMLElement ? el : null
}

/**
 * 列表真正的滚动容器。
 *
 * 表格视图里 UTable 的根就是滚动容器；滚动区（Reka UI）的根只是外框，真正滚的是它内部的
 * viewport —— 从条目往上找一个内容溢出的祖先即可，不必依赖它的内部属性名。
 */
function revealScroller(root: HTMLElement, el: HTMLElement | null): HTMLElement | null {
  if (root.scrollHeight > root.clientHeight + 1) return root
  let node: HTMLElement | null = el ?? root.querySelector<HTMLElement>('[data-entry-id]')
  while (node && node !== root) {
    if (node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

/**
 * 找条目的 DOM 元素：按属性逐个比对，而不是拼选择器 —— 条目 id 里带 `:`（`entry:<feedId>:<hash>`），
 * 塞进选择器得先转义，遍历已渲染的这十几个节点反而更省心。
 * 表格的行由 UTable 生成、标记只能挂在来源格里（见 tableMeta），所以往上找它所在的 tr。
 */
function revealElement(root: HTMLElement, id: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    if (el.dataset.entryId !== id) continue
    return el.closest('tr') ?? el
  }
  return null
}

/**
 * 条目是否完整落在滚动视口里。
 *
 * 用矩形判定而不是「滚动量 vs 估算高度」：条目高度随视图不同（图片瀑布流按封面比例算），
 * 用估算值算偏移并不可靠；没渲染出来的条目（虚拟化把它摘掉了）本就在视口外，查不到即不可见。
 */
function isFullyVisible(el: HTMLElement, root: HTMLElement): boolean {
  const item = el.getBoundingClientRect()
  const box = root.getBoundingClientRect()
  return item.top >= box.top && item.bottom <= box.bottom
}

/**
 * 条目露出多少才算「看得到、闪了有用」。
 *
 * 与决定「要不要滚」的 isFullyVisible 不同口径：这里只问用户能不能看见这一条 —— 定位到视口边缘
 * （只露一条缝）也算看见，不值得为它再滚一轮；决定要不要滚时才要求完整落在视口里。
 */
function isMostlyVisible(el: HTMLElement, root: HTMLElement): boolean {
  const item = el.getBoundingClientRect()
  const box = root.getBoundingClientRect()
  const overlap = Math.min(item.bottom, box.bottom) - Math.max(item.top, box.top)
  return overlap >= Math.min(item.height, box.height) * 0.5
}

/**
 * 表格分支的目标位置：UTable 不暴露虚拟化实例，靠「已渲染的行 + 固定行高」外推。
 *
 * 行高是常数（见 TABLE_ROW_HEIGHT），渲染出来的行又都在同一份滚动内容里，所以
 * 「目标行位置 = 锚点行位置 + 行数差 × 行高」成立，不必去量表头 / 页头占掉多少高度。
 * 只在目标行还没渲染出来时才用得上 —— 它一旦进了 DOM，就用它的真实矩形（更准）。
 */
function tableTargetOffset(root: HTMLElement, index: number): number | null {
  for (const cell of root.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const row = cell.closest('tr')
    const rowIndex = props.entries.findIndex(entry => entry.id === cell.dataset.entryId)
    if (!row || rowIndex < 0) continue
    const box = root.getBoundingClientRect()
    return root.scrollTop
      + (row.getBoundingClientRect().top - box.top) // 锚点行此刻在视口里的位置
      + (index - rowIndex) * TABLE_ROW_HEIGHT
      - (root.clientHeight - TABLE_ROW_HEIGHT) / 2 // 目标行摆到视口正中
  }
  return null
}

/**
 * 定位目标（scrollTop 坐标系），**每帧重算** —— 这是「滚得顺」的关键：
 * 虚拟化边滚边量，落点会随测量值变，用固定终点插值的话中途会被拽回去。
 *
 * 优先用条目自己的实时矩形（真值：瀑布流条目高度是估的，只有量到的才准）；
 * 还没渲染出来（虚拟化把它摘了）才退回虚拟化实例按 index 的估算（页头也占一项，要加偏移）；
 * 表格没有虚拟化实例可用，走行高外推。
 */
function revealTargetOffset(root: HTMLElement, scroller: HTMLElement, index: number, id: string): number | null {
  const el = revealElement(root, id)
  if (el) {
    const item = el.getBoundingClientRect()
    const box = scroller.getBoundingClientRect()
    // 摆到视口正中：当前位置 + 它此刻相对视口的位置 - 居中的差值
    return scroller.scrollTop + (item.top - box.top) - (scroller.clientHeight - item.height) / 2
  }
  if (view.value === 'table') return tableTargetOffset(root, index)
  // 页头在列表里也占一项（见 headerItems）
  const info = scrollAreaRef.value?.virtualizer?.getOffsetForIndex?.(headerItems.value.length + index, 'center')
  return info?.[0] ?? null
}

/**
 * 一次定位 + 最多两次纠正。
 *
 * 虚拟化的条目高度是估的（瀑布流按封面比例、图片要等加载），落点常常差一截：滑完发现那一条还在
 * 视口外就再滑一轮 —— 第二轮时它已经渲染并量过，偏移就准了。纠正次数封顶，怎么都到不了也照闪，
 * 不能让提示一直不来。**没到位就不闪**：闪在看不见的地方等于没闪。
 */
const REVEAL_MAX_CORRECTIONS = 2

/** 定位的代次：新一次定位开始后，旧的那一轮不能再闪（否则会闪在上一轮的目标上） */
let revealToken = 0

/**
 * 把「刚刚在读的那一条」拉回视野并闪一下；条目不在当前列表里时什么都不做。
 *
 * 场景：连点多次「下一篇」翻了很多篇再关掉详情，列表还停在最初点开的那一条上 —— 不自动滚回去，
 * 用户得往下翻很久才找得到自己刚读到哪儿（宽屏阅读栏同理：选中高亮跑到了视口外）。
 * 已经看得见的那条只闪不滚：用户当前的滚动位置是有意停留的，不该被一次定位推走。
 * 要滚的那条是**滑过去的**（见 glideScroll），并且**滑到了才闪** —— glideScroll 结束就是滑到了，
 * 不再靠「位置连续多少帧不变」去猜（那是上一版的做法，猜早了就会闪在还在飞的列表上）。
 *
 * **没翻过篇就不进这里**（见下面的触发点）：点开读完直接返回时列表还停在点开的那条上，
 * 没有「读到哪儿了」要找回来，滚动闪烁纯属打扰。
 */
function revealEntry(id: string): void {
  const index = props.entries.findIndex(entry => entry.id === id)
  if (index < 0) return // 换源、被「只看未读」筛掉、列表被整体替换过：没有可定位的目标

  const root = revealRoot()
  const el = root ? revealElement(root, id) : null
  if (!root || (el && isFullyVisible(el, root))) {
    // 不用滚：上一次定位若还悬着，它的闪不该带到这一条上
    stopGliding?.()
    revealToken += 1
    flashEntry(id)
    return
  }

  const scroller = revealScroller(root, el)
  if (!scroller) {
    flashEntry(id)
    return
  }

  const token = (revealToken += 1)
  let corrections = 0

  const settle = () => {
    if (token !== revealToken) return // 又开了一次定位，这一轮作废
    const current = revealElement(root, id)
    if (current && isMostlyVisible(current, root)) {
      flashEntry(id)
      return
    }
    if (corrections >= REVEAL_MAX_CORRECTIONS) {
      flashEntry(id) // 到不了了：闪一下总比什么都不做强，用户至少知道刚才读的是这条
      return
    }
    corrections += 1
    glideScroll(scroller, () => revealTargetOffset(root, scroller, index, id), settle)
  }

  glideScroll(scroller, () => revealTargetOffset(root, scroller, index, id), settle)
}

/**
 * 触发点：详情从「打开」变「关闭」。
 *
 * 认 isOpen 这一个状态，而不是各展示面的关闭动作：弹窗的关闭按钮 / Esc / 遮罩、阅读栏的 X / Esc、
 * 浏览器返回键、useEntryRoute 的地址回退，全都落在这里。currentEntry 在关闭后仍留着刚才那篇
 * （见 useEntryModal），正好就是「刚刚在读的那一条」。
 *
 * 只在详情里翻过篇（上一篇 / 下一篇）才定位 + 闪一下：没翻过就说明用户点开读完直接返回了，
 * 列表根本还停在点开的那条上，再滚再闪只是平白打扰（判据见 useEntryModal 的 navigatedInDetail）。
 */
watch([isOpen, () => currentEntry.value?.id], ([open]) => {
  if (open) return
  const id = currentEntry.value?.id
  if (id && navigatedInDetail.value) revealEntry(id)
})

// ── 表格视图 ──────────────────────────────────────────────────────────────

/**
 * 表格视图（一行一条）直接用 Nuxt UI 的 Table，而不是复用上面那套 ScrollArea 泳道虚拟化。
 *
 * 泳道虚拟化的抽象是「index -> 一个格子」，条目要自己按列摆放、跨列的东西还得复制占位（见
 * HeaderItem）；表格的抽象是「行 -> table」，列宽由 table 布局算、列头能 sticky。硬塞进泳道
 * 等于自己把 table 布局复刻一遍，而 UTable 自带 virtualize（同样是 @tanstack/vue-virtual），
 * 「只渲染视口附近的行」这条性能口径不变 —— 它的根节点就是滚动容器，页面给的
 * `flex-1 min-h-0` 落在根上（见模板）。一行一条、行高固定，也就不需要逐条测量。
 */
const TABLE_ROW_HEIGHT = 53

/**
 * 表格列：来源 / 标题（标题后紧跟浅灰摘要，同一行）/ 日期。
 *
 * 列宽只写在 th 上：表格是 table-fixed（见模板的 ui 覆盖），首行即列宽；标题列不写宽度，
 * 于是吃掉剩余空间、由 truncate 收尾 —— 一行一条的前提。
 * 两侧列在窄屏收窄（`sm:` 还原）：固定布局下它们把宽度吃光，手机上的标题就只剩几十像素。
 */
const tableColumns = computed<TableColumn<RssEntry>[]>(() => [
  {
    id: 'source',
    header: props.showFeed ? '来源' : '作者',
    meta: { class: { th: 'w-20 sm:w-48' } }
  },
  { id: 'title', header: '标题' },
  {
    id: 'date',
    header: '日期',
    // 主题的 th / td 都是左对齐，日期列单独靠右（两处都要写，th 与 td 是两套类）
    meta: { class: { th: 'w-24 sm:w-28 text-right', td: 'text-right' } }
  }
])

/**
 * 行级样式：已读整行淡显，与其它视图同一口径。
 *
 * 表格的行由 UTable 生成，挂不上 `data-entry-id` 这类属性，所以只能走它的 meta（class 允许
 * 是以行为参数的函数；读 flashId 是响应式的：函数在本组件的渲染里被调用，flashId 一变就重渲）。
 * 选中高亮不做：表格视图不参与宽屏阅读栏（见 useReaderPaneMode），打开的是弹窗，
 * 没有「左边哪一行对应右边正文」要指。
 */
const tableMeta = {
  class: {
    tr: (row: { original: RssEntry }) => [
      row.original.read ? 'opacity-60' : '',
      // 「刚刚在读的那一条」闪一下（见 revealEntry）：行挂不上 data-*，只能走 class
      row.original.id === flashId.value ? 'entry-flash' : ''
    ].filter(Boolean).join(' ')
  }
}

/** 表格里的署名：聚合视图署源名、单源页署名作者（与其它视图同规则，口径在 entryByline） */
function tableByline(entry: RssEntry): string {
  return entryByline(entry, props.showFeed)
}

/** 表格行里的摘要：只取一段，超长交给 CSS 截断（与列表视图同一份投影） */
function tableExcerpt(entry: RssEntry): string {
  return entryExcerpt(entry, 160)
}

/** 行点击：整行都是打开详情的热区（UTable 会挡掉行内 button / a 上的点击，避免双开） */
function handleTableSelect(_event: Event, row: { original: RssEntry }) {
  handleOpen(row.original)
}

/**
 * 键盘打开：UTable 只把行标成 `role="button"` + `tabindex`，不给 keydown，Enter 由这里代理。
 * 监听挂在根上（透传到 UTable 根节点），所以靠 DOM 找回这一行 —— 行上挂不了自定义属性，
 * 标记落在来源/标题格里（两格都在同一个 tr 下）。
 */
function handleTableKeydown(event: KeyboardEvent) {
  if (!(event.target instanceof HTMLElement)) return
  const id = event.target.closest('tr')?.querySelector('[data-entry-id]')?.getAttribute('data-entry-id')
  const entry = id ? props.entries.find(item => item.id === id) : undefined
  if (!entry) return
  event.preventDefault()
  handleOpen(entry)
}
</script>

<template>
  <!--
    表格视图：Nuxt UI 的 Table（自带 virtualize）。一行一条，标题后面紧跟浅灰摘要 —— 版式参考
    邮件列表那种「一行扫完」的排布（来源 / 标题+摘要 / 日期）。

    它和下面 ScrollArea 分支共用同一套「只渲染视口附近 + 页尾骨架触底加载」的口径，但容器
    不同：UTable 的根节点就是滚动容器，所以页面给的 `flex-1 min-h-0` 必须落在它的根上
    （$attrs 透传，见 defineOptions 的说明），而不能像 ScrollArea 那样套一层 h-full。
    `table-fixed` + `w-full` 是为了让标题列的 truncate 真正生效：固定布局下首行列宽即列宽，
    而**宽度必须是确定值** —— 只给 `min-w-full` 时表格自己算出来的宽度是「内容最小宽度」，
    表头那几个 `whitespace-nowrap` 的单元格会把它撑到几千像素，日期列当场被挤出可视区。
  -->
  <UTable
    v-if="view === 'table'"
    ref="tableRef"
    v-bind="$attrs"
    :data="entries"
    :columns="tableColumns"
    :meta="tableMeta"
    :virtualize="{ estimateSize: TABLE_ROW_HEIGHT, overscan: overscan ?? 8 }"
    :ui="{ base: 'table-fixed w-full' }"
    sticky="header"
    :on-select="handleTableSelect"
    empty="暂无条目"
    @keydown.enter="handleTableKeydown"
  >
    <!-- 页头（单源页的订阅源描述）当作表体的第一行：和条目一起滚走，与其它视图同一口径 -->
    <template
      v-if="header"
      #body-top
    >
      <tr>
        <td :colspan="tableColumns.length">
          <div class="px-4">
            <slot name="header" />
          </div>
        </td>
      </tr>
    </template>

    <template #source-cell="{ row }">
      <div
        :data-entry-id="row.original.id"
        class="flex min-w-0 items-center gap-1.5"
      >
        <UAvatar
          v-if="showFeed"
          :src="row.original.feed?.image"
          :alt="entryFeedName(row.original)"
          :text="entryFeedName(row.original).trim()[0] ?? 'R'"
          size="3xs"
          class="shrink-0"
        />
        <span class="truncate">{{ tableByline(row.original) }}</span>
      </div>
    </template>

    <!-- 标题加粗、摘要浅灰紧跟其后（同一行流式截断）：标题长了先挤掉摘要，与邮件列表一致 -->
    <template #title-cell="{ row }">
      <div class="truncate">
        <span
          v-if="!row.original.read"
          class="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle"
          data-unread="true"
        >
          <span class="sr-only">未读</span>
        </span>
        <span class="font-medium text-highlighted">{{ row.original.title }}</span>
        <span
          v-if="tableExcerpt(row.original)"
          class="text-muted"
        > {{ tableExcerpt(row.original) }}</span>
      </div>
    </template>

    <template #date-cell="{ row }">
      <time
        :datetime="row.original.publishedAt"
        class="text-dimmed"
      >{{ entryDate(row.original) }}</time>
    </template>

    <!-- 页尾加载骨架 = 触底信号：骨架进视口就加载下一批（与其它视图同一套 observer） -->
    <template #body-bottom>
      <tr
        v-if="showSkeleton"
        :ref="registerSkeleton"
        aria-hidden="true"
      >
        <td
          :colspan="tableColumns.length"
          class="p-4"
        >
          <USkeleton class="h-4 w-full" />
        </td>
      </tr>
      <tr v-else>
        <td
          :colspan="tableColumns.length"
          class="py-6 text-center text-xs text-muted"
        >
          已加载全部条目
        </td>
      </tr>
    </template>
  </UTable>

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
    v-else
    ref="scrollAreaRef"
    v-bind="$attrs"
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

      <!--
        页尾加载骨架。

        社交动态视图照搬条目那四段（头像圈 / 署名行 / 标题 + 摘要 / 操作栏占位），宽度、缩进、
        分隔线都和真条目同一套尺寸（`max-w-xl` + `gap-2` + `size-8` 头像，见 EntrySocialItem）：
        骨架就是「下一条正在加载」，形状对上了，加载完替换上去也不会跳版。
        顶部比真条目多留一档（真条目 py-4，这里 pt-6）：和上一条的正文分开一点，
        一眼能看出是占位而不是刚发出来的一条。

        其余视图仍用「封面 + 两行文字」的通用骨架（各视图条目形状差别大，不做逐视图还原）。
      -->
      <div
        v-else-if="isSkeleton(item)"
        :ref="registerSkeleton"
        aria-hidden="true"
      >
        <div
          v-if="view === 'social'"
          class="mx-auto w-full max-w-xl border-b border-default/60 pt-6 pb-4"
        >
          <div class="flex items-start gap-2">
            <USkeleton class="size-8 shrink-0 rounded-full" />
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <USkeleton class="h-3.5 w-28" />
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

        <div
          v-else
          class="flex flex-col gap-3"
        >
          <USkeleton class="h-40 w-full rounded-lg" />
          <USkeleton class="h-4 w-3/4" />
          <USkeleton class="mt-0 h-4 w-1/2" />
        </div>
      </div>

      <!-- 收尾提示 -->
      <p
        v-else-if="isEnd(item)"
        class="py-6 text-center text-xs text-muted"
      >
        已加载全部条目
      </p>

      <EntrySocialItem
        v-else-if="isEntry(item) && view === 'social'"
        :key="item.id"
        :entry="item"
        :data-flash="item.id === flashId ? 'true' : undefined"
        :selected="item.id === selectedId"
        :show-feed="showFeed"
        @open="handleOpen"
      />

      <EntryBlogItem
        v-else-if="isEntry(item) && view === 'blog'"
        :key="item.id"
        :entry="item"
        :data-flash="item.id === flashId ? 'true' : undefined"
        :selected="item.id === selectedId"
        :show-feed="showFeed"
        :lanes="laneCount"
        @open="handleOpen"
      />

      <EntryRowItem
        v-else-if="isEntry(item) && view === 'list'"
        :key="item.id"
        :entry="item"
        :data-flash="item.id === flashId ? 'true' : undefined"
        :selected="item.id === selectedId"
        :show-feed="showFeed"
        @open="handleOpen"
      />

      <EntryImageItem
        v-else-if="isEntry(item) && view === 'image'"
        :key="item.id"
        :entry="item"
        :data-flash="item.id === flashId ? 'true' : undefined"
        :selected="item.id === selectedId"
        @open="handleOpen"
      />

      <EntryCardItem
        v-else-if="isEntry(item)"
        :key="item.id"
        :entry="item"
        :data-flash="item.id === flashId ? 'true' : undefined"
        :selected="item.id === selectedId"
        :show-feed="showFeed"
        @open="handleOpen"
      />
    </template>
  </UScrollArea>
</template>
