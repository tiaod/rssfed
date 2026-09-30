<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RssEntry } from '~/types/rss'

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

/** 收尾项引用固定，避免每次渲染生成新对象把虚拟化测量打散 */
const endItem: EndItem = { id: '__list-end__', end: true }

type ListItem = RssEntry | SkeletonItem | EndItem

function isSkeleton(item: ListItem): item is SkeletonItem {
  return 'skeleton' in item
}

function isEnd(item: ListItem): item is EndItem {
  return 'end' in item
}

/** 真条目（把两种占位项排除掉，模板最后一段靠它收窄类型） */
function isEntry(item: ListItem): item is RssEntry {
  return !isSkeleton(item) && !isEnd(item)
}

const showSkeleton = computed(() =>
  typeof props.loadMore === 'function' && (props.hasMore?.() ?? true)
)

/**
 * 列数断点表，与 app/assets/css/main.css 的 --breakpoint-3xl/4xl 及 Tailwind 默认断点一致。
 * 虚拟化必须由 JS 知道列数（lane 决定条目落哪一列），没法交给 CSS。
 */
const BREAKPOINTS: ReadonlyArray<readonly [number, number]> = [
  [2560, 8], // 4xl
  [1792, 6], // 3xl
  [1536, 5], // 2xl
  [1280, 4], // xl
  [1024, 3], // lg
  [768, 2], // md
  [0, 1]
]

const laneCount = ref(1)

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

function resolveLanes(width: number): number {
  for (const [minWidth, lanes] of BREAKPOINTS) {
    if (width >= minWidth) return lanes
  }
  return 1
}

/** 交给虚拟化的是「真实条目 + 每列一个页尾骨架」（或收尾提示） */
const listItems = computed<ListItem[]>(() => {
  if (!props.entries.length) return props.entries
  return showSkeleton.value
    ? [...props.entries, ...skeletonItems.value]
    : [...props.entries, endItem]
})

function handleResize() {
  const next = resolveLanes(window.innerWidth)
  if (next !== laneCount.value) laneCount.value = next
}

onMounted(() => {
  laneCount.value = resolveLanes(window.innerWidth)
  window.addEventListener('resize', handleResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', handleResize))

/**
 * 单条高度估算（px），只用于还没被测量过的条目；渲染过一次后 ScrollArea 内部会记住真实高度。
 * 有封面的卡片按 min-h-40 起算，明显更高。
 */
function estimateHeight(item: ListItem | undefined): number {
  if (!item || isEnd(item)) return 72
  if (isSkeleton(item)) return 280
  return item.coverUrl ? 320 : 180
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
 */
const virtualize = computed(() => ({
  lanes: laneCount.value,
  gap: 16,
  overscan: 6,
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

function formatDate(dateStr: string): Date {
  return new Date(dateStr)
}

function getExcerpt(entry: RssEntry): string {
  // 列表查询裁剪了 content（全文）字段，摘要优先用 description（列表查询仍包含）
  const text = (entry.description || entry.content || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 150
    ? text.slice(0, 150) + '…'
    : text
}

/** 卡片署名用的订阅源名 */
function feedNameOf(entry: RssEntry): string {
  return entry.feed?.title || '未知来源'
}
</script>

<template>
  <!--
    列表虚拟化交给 Nuxt UI 的 ScrollArea（内部就是 @tanstack/vue-virtual 的官方封装）：
    只渲染视口附近的条目。手机上条目一多，每追加一批都要重新布局整棵已有 DOM
    （实测 1200 条时一次长任务 133ms），虚拟化后 DOM 数量与总条数无关。
    它自带滚动容器，所以外层容器要给它确定高度（页面里是 flex-1 + min-h-0）。
  -->
  <UScrollArea
    :items="listItems"
    :virtualize="virtualize"
    class="h-full"
    :ui="{ root: 'h-full px-4 sm:px-6' }"
  >
    <template #default="{ item }">
      <!-- 页尾加载骨架 -->
      <div
        v-if="isSkeleton(item)"
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

      <UBlogPost
        v-else-if="isEntry(item)"
        :key="item.id"
        :title="item.title"
        :description="getExcerpt(item)"
        :date="formatDate(item.publishedAt)"
        :image="item.coverUrl
          ? { src: item.coverUrl, alt: item.title }
          : undefined"
        :ui="{
          // 封面不统一裁剪比例：按原比例显示，仅限制高度区间——超长的长图裁底部，超宽的横幅裁两侧，避免过长刷屏或过短成一条线
          header: 'aspect-auto',
          image: 'h-auto min-h-40 max-h-80 object-cover object-top'
        }"
        class="cursor-pointer"
        @click="handleOpen(item)"
      >
        <!--
          署名不用 authors 数组：那条路径渲染 UUser，默认头像 32px（比正文还大），
          且 to 存在时主题带 group-hover/user:scale-115 的放大动画。
          这里用插槽自己渲染，图标尺寸和动效都可控。
        -->
        <template #authors>
          <ULink
            v-if="showFeed"
            :to="item.feed?.siteUrl"
            class="group/feed flex min-w-0 items-center gap-1.5"
          >
            <!-- 源图标由 enrichEntries 解析（本地缓存的 AVIF blob URL 优先，离线可用）；
                 没有图标时 UAvatar 用 text 显示名字首字母，不占额外空间 -->
            <UAvatar
              :src="item.feed?.image"
              :alt="feedNameOf(item)"
              :text="feedNameOf(item).trim()[0] ?? 'R'"
              size="3xs"
              class="shrink-0"
            />
            <span class="truncate text-sm text-muted transition-colors group-hover/feed:text-highlighted">
              {{ feedNameOf(item) }}
            </span>
          </ULink>
          <UUser
            v-else
            :name="item.author || feedNameOf(item)"
            :to="item.feed?.siteUrl"
          />
        </template>
      </UBlogPost>
    </template>
  </UScrollArea>
</template>
