<script setup lang="ts">
/**
 * 宽屏「列表」视图的第三栏：常驻的正文阅读栏。
 *
 * 它和窄屏 / 其他视图的 EntryDetailModal 是同一个功能的两套版式，共用 useEntryDetail 里的口径
 * （打开即已读、全文懒取、上下篇、已读与收藏）；这里只负责版式与键盘：
 *   - 一整栏：由 layout 渲染在页面面板的同级（见 layouts/default.vue），自己的顶栏与页面导航栏
 *     并排、各自占满自己的列；塞进面板 body 的话页面导航栏会横跨整行盖在它上面
 *   - 可拖动改宽：直接用 UDashboardSidebar（side="right" + resizable），和左侧订阅源栏同一套
 *     拖动、双击复位、cookie 持久化，边框把手也是同一个组件
 *   - 常驻：没有选中条目时占位提示，选中后原地换正文（不像弹窗那样遮住列表）
 *   - 单篇渲染：划卡是手机上「一篇一屏」的手势，宽屏有位置摆下上下篇按钮，不需要 Swiper 三槽
 *   - 自己的滚动容器：正文在里面滚，列表与侧边栏都不受牵连
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntryDetail from '~/components/EntryDetail.vue'
import EntryDetailSkeleton from '~/components/EntryDetailSkeleton.vue'
import { useEntryDetail } from '~/composables/useEntryDetail'
import { READER_PANE_MIN_REM, readerPaneMaxSizeRem } from '~/composables/useReaderLayout'

const { isOpen, currentEntry, entries, closeEntry, canGoPrev, canGoNext } = useEntryModal()
const {
  readBusy,
  savedBusy,
  toggleRead,
  toggleStar,
  detailEntry,
  detailLoading,
  detailViewKey,
  loadDetail,
  navWithHint
} = useEntryDetail()

/** 正文滚动容器：切篇要归零，否则会停在上一次的阅读位置 */
const bodyRef = ref<HTMLElement | null>(null)

watch(
  [isOpen, () => currentEntry.value?.id],
  ([open, id]) => {
    if (!open) return
    nextTick(() => {
      if (bodyRef.value) bodyRef.value.scrollTop = 0
    })
    void loadDetail(id)
  },
  // 阅读栏是常驻的：断点切换（弹窗 → 阅读栏）时它才挂载，首帧同样要把当前这篇取出来
  { immediate: true }
)

/**
 * 当前正在读的条目；没有（刚进页面 / 已按关闭）时为 null。
 *
 * closeEntry() 只把 isOpen 置回 false，currentEntry 会留着上一篇 —— 顶栏若直接读它，
 * 空态下就会显示上一篇的源名与页码，星标 / 阅读原文还会作用到那篇上。所以顶栏一律认 active。
 */
const active = computed(() => (isOpen.value ? currentEntry.value : null))

/** 顶栏标题与弹窗同口径：显示订阅源名字，源名缺失时回退文章标题，避免顶栏空白 */
const title = computed(() => active.value?.feed?.title || active.value?.title || '')

/** 当前篇在列表里的位置。列表还没注入上下文（或条目已不在列表里）时不显示 */
const counterLabel = computed(() => {
  const cur = active.value
  if (!cur) return ''
  const i = entries.value.findIndex(e => e.id === cur.id)
  return i >= 0 ? `${i + 1} / ${entries.value.length}` : ''
})

/**
 * 宽屏键盘：←/→ 翻篇、Esc 退出阅读（回到占位态）。
 * 焦点在输入框/可编辑区时不拦截，否则侧边栏搜索框里按 Esc 会顺手把正文关掉。
 */
function onKeydown(e: KeyboardEvent) {
  if (!isOpen.value) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    navWithHint(-1)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    navWithHint(1)
  } else if (e.key === 'Escape') {
    // 别的弹窗（编辑订阅、取消订阅确认、图片放大）自己也吃 Esc，别顺手把阅读栏一起关掉。
    // 图片放大件在 capture 阶段就 stopPropagation 了；这里管的是 reka 的 dialog。
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
    closeEntry()
  }
}

/**
 * 正文的宽度上限：沿用通用设置里的「条目详情宽度」（弹窗用它控制窗口宽度，这里用它控制正文栏里的
 * 阅读宽度）。阅读栏本身可以拖得很宽，正文不该跟着拉成一行上百字 —— 超出的宽度由 mx-auto 两边留白。
 * 选「全屏」时不限宽，与弹窗选全屏的语义一致（铺满）。这几个 max-w 类名已经在设置里出现过，
 * 动态拼接不会漏出 Tailwind 的扫描（弹窗那条路径本来就靠它）。
 */
const { settings } = useSettings()
const contentMaxWidth = computed(() =>
  settings.value.entryModalSize === 'fullscreen' ? '' : settings.value.entryModalSize
)

/** 视口宽度（跟着 resize 走）：阅读栏的拖动上限随窗口大小变，见 maxSizeRem */
const viewportWidth = ref(import.meta.client ? window.innerWidth : 1440)

function syncViewportWidth() {
  viewportWidth.value = window.innerWidth
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', syncViewportWidth)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', syncViewportWidth)
})

/**
 * 首次使用时的宽度（rem，跟 UDashboardGroup 的 unit 一致）：按视口给 38vw，夹在上下限之间。
 * 拖过之后以 cookie 里的值为准（和左侧边栏同一套存储机制），这里只在还没有值时生效。
 * 组件只在客户端挂载（readerPane 是宽屏判据，SSR 与客户端首帧都为假），读视口是安全的。
 */
const defaultSizeRem = import.meta.client
  ? Math.round(Math.min(48, Math.max(READER_PANE_MIN_REM, (window.innerWidth * 0.38) / 16)) * 10) / 10
  : 34

/** 能拖到多宽：随视口走（大屏放开到 80rem，小窗口给中间那栏留出下限），见 readerPaneMaxSizeRem */
const maxSizeRem = computed(() => readerPaneMaxSizeRem(viewportWidth.value))

/**
 * root 的 max-width 与 maxSizeRem 是同一个式子（这样拖动到头就是视觉上的头，不会「拖了却不变宽」）：
 * cookie 里存的是绝对值，窗口变小后那个值可能远超允许范围，CSS 这层负责把它压回去。
 */
const paneMaxWidth = computed(() => `${(maxSizeRem.value * 16).toFixed(0)}px`)

/**
 * 阅读栏就是一整栏可拖动的侧边栏（复用 UDashboardSidebar：同一套拖动、双击复位、cookie 持久化）。
 *
 * 顶栏沿用侧边栏主题的高度（--ui-header-height），只补一条与页面导航栏对齐的分隔线。
 * body 只做 flex 容器，滚动交给里面自己的那个 div（切篇要把它 scrollTop 归零，得能拿到 ref）。
 */
const paneUi = {
  header: 'px-4 sm:px-6 border-b border-default',
  body: 'flex flex-1 min-h-0 flex-col overflow-hidden p-0 sm:p-0'
}
</script>

<template>
  <UDashboardSidebar
    id="reader-pane"
    side="right"
    resizable
    :toggle="false"
    :auto-close="false"
    :min-size="READER_PANE_MIN_REM"
    :max-size="maxSizeRem"
    :default-size="defaultSizeRem"
    :style="{ maxWidth: paneMaxWidth }"
    aria-label="文章阅读"
    :ui="paneUi"
  >
    <!-- 顶栏高度与内边距跟页面导航栏一致（都是 --ui-header-height / px-4 sm:px-6），两栏横线接得上 -->
    <template #header>
      <UButton
        icon="i-lucide-chevron-left"
        variant="ghost"
        color="neutral"
        size="xs"
        :disabled="!canGoPrev"
        aria-label="上一篇"
        title="上一篇"
        @click="navWithHint(-1)"
      />
      <UButton
        icon="i-lucide-chevron-right"
        variant="ghost"
        color="neutral"
        size="xs"
        :disabled="!canGoNext"
        aria-label="下一篇"
        title="下一篇"
        @click="navWithHint(1)"
      />

      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-highlighted">
          {{ title }}
        </p>
      </div>

      <span
        v-if="counterLabel"
        class="shrink-0 text-xs tabular-nums text-muted"
      >{{ counterLabel }}</span>

      <!--
        已读 / 未读：图标与配色直接沿用列表页「只看未读」那个开关（ListActionsBar）——
        已读 = 空心圈、未读 = 圈内实心点 + 主色软底。全站的已读态记号只此一套（列表里的圆点、
        这里的按钮、弹窗工具栏的按钮），别再各写各的。
      -->
      <UButton
        :icon="active?.read ? 'i-lucide-circle' : 'i-lucide-circle-dot'"
        :color="active?.read ? 'neutral' : 'primary'"
        :variant="active?.read ? 'ghost' : 'soft'"
        :aria-label="active?.read ? '标为未读' : '标为已读'"
        :title="active?.read ? '标为未读' : '标为已读'"
        :loading="readBusy"
        :disabled="!active"
        size="xs"
        @click="toggleRead"
      />
      <UButton
        icon="i-lucide-star"
        :color="active?.starred ? 'warning' : 'neutral'"
        :variant="active?.starred ? 'soft' : 'ghost'"
        :aria-label="active?.starred ? '取消收藏' : '收藏'"
        :aria-pressed="active?.starred === true"
        :title="active?.starred ? '取消收藏' : '收藏'"
        :loading="savedBusy"
        :disabled="!active"
        size="xs"
        @click="toggleStar"
      />
      <UButton
        v-if="active"
        :to="active.url"
        target="_blank"
        icon="i-lucide-external-link"
        variant="ghost"
        color="neutral"
        size="xs"
        aria-label="阅读原文"
        title="阅读原文"
      />
      <UButton
        icon="i-lucide-x"
        variant="ghost"
        color="neutral"
        size="xs"
        :disabled="!isOpen"
        aria-label="关闭阅读栏"
        title="关闭阅读栏（Esc）"
        @click="closeEntry"
      />
    </template>

    <div
      ref="bodyRef"
      class="relative min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
    >
      <!--
        正文列：宽度上限取通用设置里的「条目详情宽度」，多出来的宽度由 mx-auto 两边留白。
        relative 是给下面的 .entry-fade 退场层用的（它 absolute inset-0，要按这一列的框定位）。
      -->
      <div
        v-if="active"
        class="relative mx-auto"
        :class="contentMaxWidth"
      >
        <!-- 正文未就位时只显示骨架屏：列表投影里没有全文，直接上屏会先塌再弹（与弹窗同口径） -->
        <Transition name="entry-fade">
          <div :key="detailViewKey">
            <EntryDetailSkeleton v-if="detailLoading" />
            <EntryDetail
              v-else-if="detailEntry"
              :entry="detailEntry"
            />
          </div>
        </Transition>
      </div>

      <!-- 常驻空态：三栏里这一栏始终在，没选中时说清下一步做什么 -->
      <div
        v-else
        class="grid h-full place-items-center text-center"
      >
        <div class="space-y-2">
          <UIcon
            name="i-lucide-book-open-text"
            class="size-10 text-dimmed"
          />
          <p class="text-sm text-muted">
            从列表中选择一篇开始阅读
          </p>
        </div>
      </div>
    </div>
  </UDashboardSidebar>
</template>
