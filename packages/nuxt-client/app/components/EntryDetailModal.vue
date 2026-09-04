<script setup lang="ts">
import { nextTick, ref, computed, watch, reactive, onBeforeUnmount, defineAsyncComponent } from 'vue'
import type { RssEntry } from '~/types/rss'
import 'swiper/css'

// Swiper 仅在前端按需加载（ClientOnly 包裹 + 异步组件），避免拖慢首屏与 SSR 水合差异
const SwiperView = defineAsyncComponent(() => import('swiper/vue').then(m => m.Swiper))
const SwiperSlideView = defineAsyncComponent(() => import('swiper/vue').then(m => m.SwiperSlide))

const {
  isOpen,
  currentEntry,
  entries,
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
  if (moved) revealCounter()
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

// ── 上一篇/下一篇（非全屏路径保留原样）──

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
    if (isFullscreen.value) {
      scheduleAlign(false)
    } else {
      nextTick(resetScroll)
      loadDetail(id)
    }
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
  if (!import.meta.client || typeof window === 'undefined') return
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

// 非全屏（居中弹窗）在触屏设备上的原生划卡：横向位移足够、接近水平、速度够快才翻页
const touchStart = { x: 0, y: 0, t: 0 }

function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  touchStart.x = t.clientX
  touchStart.y = t.clientY
  touchStart.t = performance.now()
}

function onTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - touchStart.x
  const dy = t.clientY - touchStart.y
  const dt = performance.now() - touchStart.t
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 1.2 || dt > 500) return
  navWithHint(dx < 0 ? 1 : -1)
}

// ── 全屏路径：用 Swiper 做「上一篇/下一篇」划卡 ──
//
// 为避免一次性渲染整份列表，Swiper 只铺当前篇两侧「真实存在」的物理槽：
// 列表中部仍是三槽 [上一篇][当前][下一篇]，当前篇在对齐到它的中间位；
// 贴到第一篇/最后一篇时不再塞空的占位槽——那一侧没有滑道可滑，滑过去就是
// Swiper 自带的边缘回弹，而不是一整页「已经是第一篇了」的提示。
// 系统触发（打开、键盘 ←/→、桌面浮钮）都会重新把滑块对齐到当前篇所在槽位。

/** 过渡动画时长（毫秒） */
const SWIPE_SPEED = 300

// Swiper 实例方法带强 `this` 约束，这里只保留本组件用到的最小面，
// 赋值时做一次类型放松即可，不影响运行时
interface LinkSwiper {
  destroyed: boolean
  activeIndex: number
  slides: HTMLElement[]
  update(): void
  slideTo(index: number, speed?: number, runCallbacks?: boolean): void
}

const swiperInst = ref<LinkSwiper | null>(null)
/** 正处于我们程序化位移（slideTo）引起的过渡中：该次 transitionend 一律吞掉，避免二次翻页 */
const aligning = ref(false)
let alignTimer: ReturnType<typeof setTimeout> | undefined

function clearAlignTimer() {
  if (alignTimer) {
    clearTimeout(alignTimer)
    alignTimer = undefined
  }
}

/**
 * 当前条目所在的物理索引：中部三槽恒为 1；只有上一篇或只有下一篇时是 0 / 1，
 * 单篇则是 0。因为没有空槽参与占位，靠这个值来代替原先写死的「中间槽 = 1」。
 */
function currentSlideIndex() {
  const found = slots.value.findIndex(s => s.raw?.id === currentEntry.value?.id)
  return found >= 0 ? found : 0
}

/** 静默或带动画地把滑块拨回到当前篇所在槽位 */
function alignOrbit(withAnim = false) {
  const sw = swiperInst.value
  if (!sw || sw.destroyed) return
  // 闸门只在「带动画的位移」时开启：动画过程会产生 transitionend，需要防自家的位移回灌成一次翻页。
  // 静默复位（speed 0）是瞬间到位、不产生过渡事件，就不该锁帧——否则刚打开弹窗的那约 720ms
  // 窗口会把紧接着的用户第一次划卡误判成「自己的过渡」而吞掉，表现为首篇划不动。
  if (withAnim) {
    aligning.value = true
    clearAlignTimer()
    // 兜底：万一这次位移没有走到 transitionend（例如宽度未变化被跳过），也定时放开闸门
    alignTimer = setTimeout(() => { aligning.value = false }, SWIPE_SPEED + 420)
  }
  sw.update()
  sw.slideTo(currentSlideIndex(), withAnim ? SWIPE_SPEED : 0)
}

function scheduleAlign(withAnim = false) {
  nextTick(() => {
    // 抹平后再把当前篇的正文滚回顶部，避免跳到之前读到一半的位置
    const activeSlide = swiperInst.value?.slides[currentSlideIndex()]
    if (activeSlide) activeSlide.scrollTop = 0
    alignOrbit(withAnim)
  })
}

function onSwiperReady(sw: unknown) {
  swiperInst.value = sw as LinkSwiper
  slidesWaitTicks = 0
  waitForSlidesThenAlign()
}

// SwiperView/SwiperSlideView 都是懒加载异步组件，冷启动首次打开时根组件会比子槽更早挂载，
// 此时 onSwiperReady 拿到的是 slides=0 的半成品实例：updateSlides 推不出有效网格
// （slidesGrid 空、snapGrid 只剩 [0]），横向划卡会原地不动、直到关掉重开才恢复。
// 这里等真正的 slide 子件挂载到位（通常一两帧，热缓存时第一帧即就绪）再对齐。
const ALIGN_WAIT_FRAMES = 30
let slidesWaitTicks = 0
function waitForSlidesThenAlign() {
  const sw = swiperInst.value
  if (!sw || sw.destroyed) return
  if (sw.slides.length > 0 || slidesWaitTicks >= ALIGN_WAIT_FRAMES) {
    scheduleAlign(false)
    return
  }
  slidesWaitTicks += 1
  requestAnimationFrame(waitForSlidesThenAlign)
}

function onTransitionEnd() {
  const wasAligning = aligning.value
  aligning.value = false
  clearAlignTimer()
  revealCounter() // 任何一次划卡落定（包括切到新一篇）都把页码亮回来
  const cur = currentSlideIndex()
  const pos = swiperInst.value?.activeIndex
  if (pos === undefined) return
  if (wasAligning) {
    // 我们自己的程序化位移所致的过渡：不翻页。若落点偏离当前槽（理论上不该发生，
    // 但极端时序下可能残留），就地静默纠正，别让滑块悬在错位上等着下一次手势
    if (pos !== cur) alignOrbit(false)
    return
  }
  if (pos === cur) return
  const dir = pos > cur ? 1 : -1
  const toNext = dir === 1
  if (toNext && canGoNext.value) {
    goNext()
    return
  }
  if (!toNext && canGoPrev.value) {
    goPrev()
    return
  }
  // 起点/终点：轻轻弹回中间并有提示，与键盘/浮钮共用文案
  if (toNext) {
    if (isLastWithNoMore()) toast.add({ title: '没有下一篇了', color: 'neutral' })
  } else if (!canGoPrev.value) {
    toast.add({ title: '已经是第一篇了', color: 'neutral' })
  }
  alignOrbit(true)
}

// 打开弹窗时对齐一次（打开前异步 Swiper 可能尚未就绪，交给 onSwiperReady 兜底）
watch(isOpen, (open) => {
  if (open) scheduleAlign(false)
})

// ── 三槽窗口：与 useEntryModal 的列表联动 ──

const idx = computed(() => {
  const cur = currentEntry.value
  if (!cur) return -1
  return entries.value.findIndex(e => e.id === cur.id)
})

interface Slot {
  raw: RssEntry | null
  hint: string
}

const slots = computed<Slot[]>(() => {
  const cur = currentEntry.value
  const i = idx.value
  const list = entries.value
  if (!isOpen.value || i < 0 || list.length === 0) {
    return cur ? [{ raw: cur, hint: '' }] : [{ raw: null, hint: '' }]
  }
  // 只铺真实存在的邻项：第一篇不铺「上一篇」空槽、最后一篇不铺「下一篇」空槽，
  // 让那一侧的边缘直接由 Swiper 挡住，不再出现占位提示页
  const arr: Slot[] = []
  if (i - 1 >= 0) arr.push({ raw: list[i - 1]!, hint: '' })
  arr.push({ raw: list[i]!, hint: '' })
  if (i + 1 < list.length) arr.push({ raw: list[i + 1]!, hint: '' })
  return arr
})

// 槽内全文也是懒取的：按 id 缓存，命中的直接复用，未命中先展示投影 + 骨架
const details = reactive(new Map<string, RssEntry | null>())
const loadingIds = reactive(new Set<string>())

function hydrateSlots() {
  if (!isOpen.value) return
  for (const s of slots.value) {
    const raw = s.raw
    if (!raw || details.has(raw.id) || loadingIds.has(raw.id)) continue
    loadingIds.add(raw.id)
    const prj = raw
    pouch
      .getEntry(raw.id)
      .then(full => { if (full) details.set(raw.id, full) })
      .catch(() => details.set(raw.id, prj)) // 取不到全文就保住投影，至少能看标题
      .finally(() => loadingIds.delete(raw.id))
  }
}

// 当前位置/总数（右上角页码）
const counterLabel = computed(() => {
  const i = idx.value
  return `${i >= 0 ? i + 1 : 0} / ${entries.value.length}`
})

// 阅读时（正文向下滚动超过阈值）隐去右上角页码，滑回顶部或左右翻页结束时再浮出。
// 全屏路径的滚动容器不唯一（固定顶栏时是 slide 内部滚动，不固定时是整个 overlay），
// 但 scroll 事件在捕获阶段仍会向上传播，挂在 document 上用 capture 就能统一收齐。
const COUNTER_HIDE_GAP = 24
const showingCounter = ref(true)

function syncCounterOnScroll(e: Event) {
  if (!isOpen.value) return
  const scroller = e.target
  // document 走整体页面向下滚动量
  if (scroller === document) {
    showingCounter.value = window.scrollY <= COUNTER_HIDE_GAP
    return
  }
  // 其余情形为可滚动元素；用 instanceof Element 收窄后读取 scrollTop
  if (!(scroller instanceof Element)) return
  showingCounter.value = scroller.scrollTop <= COUNTER_HIDE_GAP
}

/** 左右切篇或划卡结束后即将展示新一页的顶部，强制亮出页码 */
function revealCounter() {
  showingCounter.value = true
}

watch(slots, hydrateSlots, { immediate: true })

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

if (import.meta.client) {
  mql = window.matchMedia('(max-width: 767px)')
  isSmallScreen.value = mql.matches
  mql.addEventListener('change', onScreenChange)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('scroll', syncCounterOnScroll, { capture: true, passive: true })
}

onBeforeUnmount(() => {
  mql?.removeEventListener('change', onScreenChange)
  if (import.meta.client) {
    window.removeEventListener('popstate', onPopState)
    window.removeEventListener('keydown', onKeydown)
    document.removeEventListener('scroll', syncCounterOnScroll, { capture: true })
  }
  clearAlignTimer()
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
      // UModal body 基础类是 p-4 sm:p-6 且 ui 覆盖只做合并不会替换，必须显式 p-0 清掉，
      // 否则和 slide 内的 px-4 sm:px-6 叠出双倍水平边距
      body: 'flex-1 min-h-0 p-0 sm:p-0',
      footer: 'shrink-0 px-4 sm:px-6 py-2',
      close: 'top-1/2 -translate-y-1/2',
      ...TRUNCATE_UI,
    }
  }
  // 同样的原因，全屏不固定栏这条路径也要清掉 body 默认的内边距
  return { content: 'min-h-dvh flex flex-col', body: 'flex-1 p-0 sm:p-0', ...TRUNCATE_UI }
})

/** 槽内展示用条目：全文取到后换全文，否则先用列表投影的标题/元信息顶着 */
function displayOf(raw: RssEntry | null): RssEntry | null {
  if (!raw) return null
  return details.get(raw.id) ?? raw
}

function isLoading(raw: RssEntry | null): boolean {
  return !!raw && !details.has(raw.id) && loadingIds.has(raw.id)
}
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
      <!-- 全屏（手机恒定全屏，桌面选全屏档也是）：Swiper 三槽划卡 -->
      <div
        v-if="isFullscreen"
        class="article-swiper relative h-full"
      >
        <ClientOnly>
          <SwiperView
            :slides-per-view="1"
            :space-between="0"
            :speed="SWIPE_SPEED"
            :grab-cursor="settings.entryModalSize === 'fullscreen' && !isSmallScreen"
            :threshold="12"
            class="h-full"
            @swiper="onSwiperReady"
            @transitionEnd="onTransitionEnd"
          >
            <SwiperSlideView
              v-for="(slot, i) in slots"
              :key="slot.raw?.id ?? `edge-${i}`"
              class="h-full overflow-y-auto article-slide"
            >
              <div
                v-if="!slot.raw"
                class="grid h-full min-h-full place-items-center px-6 text-center text-sm text-muted"
              >
                {{ slot.hint }}
              </div>
              <!--
                此前这里手写了 article>header 标题后又嵌了 EntryDetail，
                造成整块标题/元信息重复渲染，且两层 prose 叠加出双倍留白。
                现在只留水平内边距，单篇的标题/正文统一交给 EntryDetail 渲染；
                全文未就位前先用骷髅占位，避免投影里缺 content 时的空白闪烁。
              -->
              <div
                v-else
                class="px-4 sm:px-6 py-4 sm:py-6"
              >
                <div
                  v-if="isLoading(slot.raw)"
                  class="space-y-4"
                  aria-busy="true"
                >
                  <USkeleton class="h-7 w-[85%]" />
                  <USkeleton class="h-3 w-44" />
                  <div class="pt-2 space-y-3">
                    <USkeleton class="h-4 w-full" />
                    <USkeleton class="h-4 w-[94%]" />
                    <USkeleton class="h-4 w-[88%]" />
                    <USkeleton class="h-4 w-[97%]" />
                    <USkeleton class="h-4 w-[64%]" />
                  </div>
                </div>
                <EntryDetail
                  v-else
                  :entry="displayOf(slot.raw)!"
                />
              </div>
            </SwiperSlideView>
          </SwiperView>
        </ClientOnly>

        <Transition name="counter-fade">
          <div
            v-show="showingCounter"
            class="pointer-events-none absolute bottom-1.5 right-2 z-10 rounded-full bg-white/70 px-2 py-0.5 text-xs text-muted backdrop-blur-sm dark:bg-gray-950/70"
          >
            {{ counterLabel }}
          </div>
        </Transition>
      </div>

      <!-- 非全屏（桌面居中弹窗）：保持单条渲染与原有的触屏手势 -->
      <div
        v-else
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

  <!-- 电脑端：弹窗两侧的上一篇/下一篇浮钮；小屏不渲染，改用触屏滑动 -->
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

<!-- swiper 输出的节点不在内层作用域内，需要全局样式：把三槽撑满高度，正文在各自槽内纵向滚动 -->
<style>
.article-swiper .swiper,
.article-swiper .swiper-wrapper {
  height: 100%;
}

.article-swiper .swiper-slide {
  height: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* 页码渐入渐出 */
.counter-fade-enter-active,
.counter-fade-leave-active {
  transition: opacity 0.25s ease;
}

.counter-fade-enter-from,
.counter-fade-leave-to {
  opacity: 0;
}
</style>
