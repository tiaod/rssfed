<script setup lang="ts">
import { nextTick, ref, watch, onBeforeUnmount } from 'vue'
import type { RssEntry } from '~/types/rss'

const {
  isOpen,
  currentEntry,
  closeEntry,
  goPrev,
  goNext,
  canGoPrev,
  canGoNext,
  isLastWithNoMore,
} = useEntryModal()
const { settings } = useSettings()
const toast = useToast()

// 到了尽头还要继续翻时不再无声失败：无更多数据（hasMore 为假）提示结尾，开头则提示已到首篇
function navWithHint(dir: -1 | 1) {
  const moved = dir === 1 ? goNext() : goPrev()
  if (moved || !isOpen.value) return
  if (dir === 1) {
    if (isLastWithNoMore()) toast.add({ title: '没有下一篇了', color: 'neutral' })
  } else if (!canGoPrev.value) {
    toast.add({ title: '已经是第一篇了', color: 'neutral' })
  }
}

// 小屏设备（手机）始终全屏；大屏按设置：选「全屏」档时也全屏
const isSmallScreen = ref(false)
const isFullscreen = computed(() => isSmallScreen.value || settings.value.entryModalSize === 'fullscreen')
// 非全屏（居中弹窗）或全屏但未固定顶/底栏时，整个模态随 overlay 滚动
const isScrollable = computed(() => !isFullscreen.value || !settings.value.fixedBars)

let mql: MediaQueryList | null = null
function onScreenChange(event: MediaQueryListEvent) {
  isSmallScreen.value = event.matches
}

// ── 上一篇/下一篇 ──

// 正文滚动容器在不同展示模式下不同（居中弹窗为 overlay 滚动；全屏固定栏为 body 内部滚动），
// 切换条目时把 window 与正文所在的所有可滚动祖先统一归零，避免停留在上一篇的阅读位置
const bodyRef = ref<HTMLElement | null>(null)

// 列表行来自 map view 投影（为省内存刻意不携带正文全文 content），弹窗需按 id 拉完整文档再渲染，
// 否则正文区永远空白。切换上一篇/下一篇时同步加载新条目的全文；竞态由 id 比对防止旧结果覆盖。
const pouch = usePouchDb()
const detailEntry = ref<RssEntry | null>(null)

watch(
  () => currentEntry.value?.id,
  (id) => {
    nextTick(resetScroll)
    loadDetail(id)
  },
  { immediate: true }
)

async function loadDetail(id: string | undefined) {
  detailEntry.value = currentEntry.value
  if (!id) return
  const full = await pouch.getEntry(id)
  if (currentEntry.value?.id === id) {
    detailEntry.value = full ?? currentEntry.value
  }
}

function resetScroll() {
  window.scrollTo(0, 0)
  if (!bodyRef.value) return
  let el: HTMLElement | null = bodyRef.value
  while (el) {
    if (
      el.scrollHeight > el.clientHeight &&
      (el.style.overflowY === 'auto' || el.style.overflowY === 'scroll' ||
        /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    ) {
      el.scrollTop = 0
    }
    el = el.parentElement
  }
}

// 移动端触屏：横向滑动翻页。竖向主导或距离太短/拖拽太久的手势视为滚动，不误翻
const swipe = ref<{ x: number, y: number, t: number } | null>(null)

function onTouchStart(e: TouchEvent) {
  const touch = e.touches[0]
  if (!touch) return
  swipe.value = { x: touch.clientX, y: touch.clientY, t: performance.now() }
}

function onTouchEnd(e: TouchEvent) {
  if (!swipe.value) return
  const touch = e.changedTouches[0]
  if (!touch) {
    swipe.value = null
    return
  }
  const dx = touch.clientX - swipe.value.x
  const dy = touch.clientY - swipe.value.y
  const dt = performance.now() - swipe.value.t
  swipe.value = null
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 1.2 || dt > 500) return
  if (dx < 0) {
    navWithHint(1)
  } else {
    navWithHint(-1)
  }
}

// 电脑端键盘 ←/→ 快速翻页（焦点在输入框/可编辑区时不拦截）
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
  }
}

// 浏览器返回键可关闭弹窗：
// 打开时压入一条历史记录，返回键触发 popstate 时关闭（浏览器已自动出栈）；
// 程序化关闭（关闭按钮/Esc/遮罩）时若该记录仍在栈顶则退掉，避免历史堆积
const HISTORY_KEY = '__entryModal'

function onPopState() {
  if (isOpen.value) {
    isOpen.value = false
  }
}

watch(isOpen, (open, wasOpen) => {
  if (!import.meta.client) return
  if (open) {
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: true }, '', window.location.href)
  } else if (wasOpen && window.history.state?.[HISTORY_KEY]) {
    window.history.go(-1)
  }
})

if (import.meta.client) {
  mql = window.matchMedia('(max-width: 767px)')
  isSmallScreen.value = mql.matches
  mql.addEventListener('change', onScreenChange)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('keydown', onKeydown)
}

onBeforeUnmount(() => {
  mql?.removeEventListener('change', onScreenChange)
  if (import.meta.client) {
    window.removeEventListener('popstate', onPopState)
    window.removeEventListener('keydown', onKeydown)
  }
})

// 标题过长时省略号截断，并预留右侧关闭按钮空间（各模式通用）
const TRUNCATE_UI = {
  wrapper: 'min-w-0 flex-1 pe-10',
  title: 'truncate',
}

// 全屏 + 固定顶/底栏：content 铺满视口，body 内部滚动、header/footer 固定
// 全屏 + 不固定：整个模态（含 header/footer）随 overlay 一起滚动，短内容至少铺满高度
// 非全屏：按设置的宽度控制
const modalUi = computed(() => {
  if (!isFullscreen.value) {
    return { content: settings.value.entryModalSize, ...TRUNCATE_UI }
  }
  if (settings.value.fixedBars) {
    return {
      content: 'h-dvh flex flex-col',
      header: 'relative shrink-0 min-h-12 py-2.5 px-4 sm:px-6',
      body: 'flex-1 min-h-0',
      footer: 'shrink-0 px-4 sm:px-6 py-2',
      close: 'top-1/2 -translate-y-1/2',
      ...TRUNCATE_UI,
    }
  }
  return { content: 'min-h-dvh flex flex-col', ...TRUNCATE_UI }
})
</script>

<template>
  <UModal
    v-model:open="isOpen"
    :title="currentEntry?.title"
    :fullscreen="isFullscreen"
    :scrollable="isScrollable"
    :ui="modalUi"
  >
    <template #body>
      <div
        ref="bodyRef"
        class="min-h-full"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <EntryDetail
          v-if="detailEntry"
          :entry="detailEntry"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <UButton
          v-if="currentEntry"
          :to="currentEntry.url"
          target="_blank"
          label="阅读原文"
          icon="i-lucide-external-link"
          variant="outline"
          size="sm"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          size="sm"
          @click="closeEntry"
        >
          关闭
        </UButton>
      </div>
    </template>
  </UModal>

  <!-- 电脑端：弹窗两侧的上一篇/下一篇浮钮；小屏不渲染，改用触屏滑动（见 onTouchStart/onTouchEnd） -->
  <Teleport to="body">
    <div
      v-if="isOpen && !isSmallScreen"
      class="pointer-events-none fixed inset-y-0 left-0 right-0 z-[70] flex items-center justify-between px-3 sm:px-6"
    >
      <UButton
        square
        color="neutral"
        variant="soft"
        class="pointer-events-auto rounded-full shadow-md"
        :disabled="!canGoPrev"
        aria-label="上一篇"
        title="上一篇"
        @click="navWithHint(-1)"
      >
        <UIcon
          name="i-lucide-chevron-left"
          class="size-5"
        />
      </UButton>
      <UButton
        square
        color="neutral"
        variant="soft"
        class="pointer-events-auto rounded-full shadow-md"
        :disabled="!canGoNext"
        aria-label="下一篇"
        title="下一篇"
        @click="navWithHint(1)"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="size-5"
        />
      </UButton>
    </div>
  </Teleport>
</template>
