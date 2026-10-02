<script setup lang="ts">
/**
 * 宽屏「列表」视图的第三栏：常驻的正文阅读栏。
 *
 * 它和窄屏 / 其他视图的 EntryDetailModal 是同一个功能的两套版式，共用 useEntryDetail 里的口径
 * （打开即已读、全文懒取、上下篇、已读与收藏）；这里只负责版式与键盘：
 *   - 一整栏：由 layout 渲染在页面面板的同级（见 layouts/default.vue），自己的顶栏与页面导航栏
 *     并排、各自占满自己的列；塞进面板 body 的话页面导航栏会横跨整行盖在它上面
 *   - 常驻：没有选中条目时占位提示，选中后原地换正文（不像弹窗那样遮住列表）
 *   - 单篇渲染：划卡是手机上「一篇一屏」的手势，宽屏有位置摆下上下篇按钮，不需要 Swiper 三槽
 *   - 自己的滚动容器：正文在里面滚，列表与侧边栏都不受牵连
 *
 * 宽度按视口比例给（38vw），上下限兜住两端：窄一点的笔记本（1024px）上正文不至于压缩成一条，
 * 超宽屏上正文也不会拉成一行上百字的阅读长条。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EntryDetail from '~/components/EntryDetail.vue'
import EntryDetailSkeleton from '~/components/EntryDetailSkeleton.vue'
import { useEntryDetail } from '~/composables/useEntryDetail'

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

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!--
    一整栏：38vw + 20rem~48rem。左边界的分隔线来自 UDashboardPanel 的 lg:not-last:border-e
    （面板后面跟着这一栏，所以它必然吃到那条边），这里不再自己加 border-s，否则是两条线。
  -->
  <aside
    class="flex min-h-0 w-[clamp(20rem,38vw,48rem)] shrink-0 flex-col"
    aria-label="文章阅读"
  >
    <!-- 顶栏与页面导航栏同高同内边距（都是 --ui-header-height / px-4 sm:px-6），两栏横线接得上 -->
    <header class="flex h-(--ui-header-height) shrink-0 items-center gap-1 border-b border-default px-4 sm:px-6">
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

      <UButton
        :icon="active?.read ? 'i-lucide-mail-open' : 'i-lucide-mail'"
        :aria-label="active?.read ? '标为未读' : '标为已读'"
        :title="active?.read ? '标为未读' : '标为已读'"
        :loading="readBusy"
        :disabled="!active"
        variant="ghost"
        color="neutral"
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
    </header>

    <div
      ref="bodyRef"
      class="relative min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
    >
      <!-- 正文未就位时只显示骨架屏：列表投影里没有全文，直接上屏会先塌再弹（与弹窗同口径） -->
      <Transition
        v-if="active"
        name="entry-fade"
      >
        <div :key="detailViewKey">
          <EntryDetailSkeleton v-if="detailLoading" />
          <EntryDetail
            v-else-if="detailEntry"
            :entry="detailEntry"
          />
        </div>
      </Transition>

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
  </aside>
</template>
