<script setup lang="ts">
import { nextTick, ref, computed, watch, reactive, onBeforeUnmount, defineAsyncComponent } from 'vue'
import type { RssEntry } from '~/types/rss'
// 打开即已读、全文懒取、上一篇/下一篇、工具栏的已读与收藏：与宽屏阅读栏共用同一份口径
import { useEntryDetail } from '~/composables/useEntryDetail'
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
  isLastWithNoMore
} = useEntryModal()
const { settings } = useSettings()
const toast = useToast()

// 详情相关的状态与动作（含「到尽头时的提示」）都在共享 composable 里，见 useEntryDetail
const {
  readBusy,
  savedBusy,
  toggleRead,
  toggleStar,
  details,
  loadingIds,
  detailEntry,
  detailLoading,
  detailViewKey,
  loadDetail,
  displayOf,
  isLoading,
  navWithHint: navEntryWithHint
} = useEntryDetail()

/** 翻页：尽头提示由共享 composable 发，弹窗这边额外把页码亮回来（正文滚动时它会被隐去） */
function navWithHint(dir: -1 | 1) {
  if (navEntryWithHint(dir)) revealCounter()
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

/**
 * 当前正显示的正文高度（px）。
 *
 * 切篇时全文要先加载，这段时间让骨架屏按这个高度铺开撑住弹窗尺寸，
 * 就不会出现「先缩成小骨架、再弹成新正文」的两次尺寸变化。
 */
const detailSkeletonHeight = ref(0)

watch(
  [isOpen, () => currentEntry.value?.id],
  ([open, id]) => {
    if (isFullscreen.value) {
      if (open) scheduleAlign(false)
      return
    }
    if (!open) return
    // 记下此刻（DOM 还是上一篇正文）的高度给骨架屏用。
    // 只记有效值：关闭后正文节点已卸载、量不到高度，就沿用上一次的值，
    // 这样重新打开弹窗也会按上次阅读的正文尺寸撑住，而不是先缩成小骨架再弹开。
    const shownHeight = bodyRef.value?.offsetHeight ?? 0
    if (shownHeight) detailSkeletonHeight.value = shownHeight
    nextTick(resetScroll)
    loadDetail(id)
  },
  { immediate: true }
)

// ── 正文切换的淡入淡出 ──
//
// 弹窗高度由正文长度决定，切篇时框体尺寸必然要变。给高度本身做过渡观感并不好
// （长文收短像被「抽走」），所以尺寸就让它一步到位，只让内容交叉淡入淡出：
// 新内容（或骨架屏）立刻占据正常流、框体高度随之确定，旧内容退场时改为绝对定位并裁切，
// 两层叠着淡入淡出，既不会出现空窗，也不会先塌再弹。

function resetScroll() {
  if (!import.meta.client || typeof window === 'undefined') return
  window.scrollTo(0, 0)
  if (!bodyRef.value) return
  let el: HTMLElement | null = bodyRef.value
  while (el) {
    if (
      el.scrollHeight > el.clientHeight
      && (el.style.overflowY === 'auto' || el.style.overflowY === 'scroll'
        || /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    ) {
      el.scrollTop = 0
    }
    el = el.parentElement
  }
}

/**
 * 拦下正文区的 pointerdown，不让它冒泡到 reka-ui 的遮罩层。
 *
 * `scrollable` 的模态（居中弹窗，以及全屏但不固定顶/底栏）在 DOM 上把内容嵌在遮罩层里面，
 * 而 reka-ui 给遮罩层挂了 `pointerdown` + `.left.prevent`（原意只是「点遮罩本身别选中东西」）。
 * 事件从正文冒泡上去同样会被 preventDefault —— 浏览器随后就不再补发 mousedown，
 * 没有 mousedown，鼠标拖选根本不会开始，正文于是「选不中」。
 * 在正文这一层就地掐断冒泡即可：遮罩层那个处理器除了 preventDefault 什么都不做。
 */
function stopPointerDownPropagation(event: PointerEvent) {
  event.stopPropagation()
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
    alignTimer = setTimeout(() => {
      aligning.value = false
    }, SWIPE_SPEED + 420)
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

// 槽内全文懒取：给三槽的每个条目补齐全文（命中缓存的跳过），未命中先展示投影 + 骨架。
// 三槽预取是划卡全屏档特有的（阅读栏一次只显示一篇），所以这里自己读本地库
const pouch = usePouchDb()

function hydrateSlots() {
  if (!isOpen.value) return
  for (const s of slots.value) {
    const raw = s.raw
    if (!raw || details.has(raw.id) || loadingIds.has(raw.id)) continue
    loadingIds.add(raw.id)
    const prj = raw
    pouch
      .getEntry(raw.id)
      .then((full) => { if (full) details.set(raw.id, full) })
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

/**
 * 路由状态一律读 `router.currentRoute`，不用 `useRoute()`：Nuxt 的 `_route` 是浅拷贝，
 * 在导航收尾之后才同步，而 isOpen 变 true 的这一刻它可能还停在**上一条地址**上（实测如此）。
 * 这里判错一次的代价是：本该跳过的那条历史被压进去 —— 返回键要按两次才关得掉详情，
 * 关闭时的 go(-1) 也会退到同一条地址上。
 */
const router = useRouter()

/**
 * 打开这一篇时地址里是否已经带着它（单源页的 `/rss/feed/:id/entry/:entryId`）。
 *
 * 带着就说明「在读哪一篇」由路由承载：返回键与关闭都交给路由（见 useEntryRoute），
 * 这里再压一条自己的历史记录会和路由的历史打架 —— 关闭时的 go(-1) 会退到同一个地址上，
 * 弹窗看起来没关掉，而路由那边又把它重新打开。
 *
 * 必须在**打开那一刻**定死：关闭时地址可能已经被页面改回列表页，那时再读就晚了。
 */
let openedWithUrl = false

function onPopState() {
  if (isOpen.value) {
    isOpen.value = false
  }
}

watch(isOpen, (open, wasOpen) => {
  // 服务端没有 window / 历史栈（用 typeof window 而不是 import.meta.client：这段历史交互要能在
  // 单测里跑，import.meta.client 在 vitest 里恒为 undefined，会把整段逻辑一起跳过）
  if (typeof window === 'undefined') return
  if (open) {
    openedWithUrl = Boolean(router.currentRoute.value.params.entryId)
    if (!openedWithUrl) {
      window.history.pushState({ ...window.history.state, [HISTORY_KEY]: true }, '', window.location.href)
    }
  } else if (wasOpen && !openedWithUrl && window.history.state?.[HISTORY_KEY]) {
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
  title: 'truncate'
}

// 弹窗内容节点的标记类：桌面端翻页浮钮靠它量出弹窗的左右边缘（见 syncNavInset）
const MODAL_CONTENT_CLASS = 'entry-detail-modal-content'

// 全屏 + 固定顶/底栏：content 铺满视口，body 内部滚动、header/footer 固定
// 全屏 + 不固定：整个模态（含 header/footer）随 overlay 一起滚动，短内容至少铺满高度
// 非全屏：按设置的宽度控制
const modalUi = computed(() => {
  if (!isFullscreen.value) {
    return { content: `${MODAL_CONTENT_CLASS} ${settings.value.entryModalSize}`, ...TRUNCATE_UI }
  }
  if (settings.value.fixedBars) {
    return {
      content: `${MODAL_CONTENT_CLASS} h-dvh flex flex-col`,
      header: 'relative shrink-0 min-h-12 py-2.5 px-4 sm:px-6',
      // UModal body 基础类是 p-4 sm:p-6 且 ui 覆盖只做合并不会替换，必须显式 p-0 清掉，
      // 否则和 slide 内的 px-4 sm:px-6 叠出双倍水平边距
      body: 'flex-1 min-h-0 p-0 sm:p-0',
      footer: 'shrink-0 px-4 sm:px-6 py-2',
      close: 'top-1/2 -translate-y-1/2',
      ...TRUNCATE_UI
    }
  }
  // 同样的原因，全屏不固定栏这条路径也要清掉 body 默认的内边距
  return { content: `${MODAL_CONTENT_CLASS} min-h-dvh flex flex-col`, body: 'flex-1 p-0 sm:p-0', ...TRUNCATE_UI }
})

// ── 电脑端翻页浮钮的横向落点 ──
//
// 浮钮原先固定贴屏幕两端：桌面窗口越宽、弹窗越窄（如 sm:max-w-6xl），
// 按钮离弹窗边缘就越远，鼠标要长距离移动才点得到。
// 这里量弹窗内容的布局几何，把浮钮摆到弹窗左右边缘外侧；正文落地后几何还会变，见 observeContent。
//
// 用 offsetLeft/offsetWidth 而不是 getBoundingClientRect：入场动画是 scale(.95→1)，
// 缩放会污染 rect 的读数，而布局盒尺寸不受 transform 影响，因此不必等动画结束再对齐。
// offsetParent 是铺满视口的遮罩层，故 offsetLeft 即内容在视口中的横坐标。
// 全屏档弹窗铺满视口，直接退化为贴屏幕两侧的最小留白（与旧行为一致）。
const NAV_BUTTON_SPAN = 52 // 浮钮边长(40) + 浮钮与弹窗边缘的间距(12)
const NAV_EDGE_MIN = 12 // 浮钮到屏幕边缘的最小留白（全屏或窗口过窄时的兜底）

/** 浮钮容器到视口左右两侧的距离 */
const navInset = reactive({ left: NAV_EDGE_MIN, right: NAV_EDGE_MIN })

/** 等待弹窗内容挂载的逐帧重试句柄 */
let navSyncRaf = 0

function syncNavInset(retry = 0) {
  if (!import.meta.client || !isOpen.value) return
  cancelAnimationFrame(navSyncRaf)
  if (isFullscreen.value) {
    // 全屏铺满视口，浮钮贴屏幕两侧：不再需要量内容几何，也不必继续观察它
    stopObservingContent()
    navInset.left = NAV_EDGE_MIN
    navInset.right = NAV_EDGE_MIN
    return
  }
  // reka-ui 的内容节点挂载晚于 isOpen 变化，首帧可能还查不到，逐帧重试到出现为止
  const content = document.querySelector<HTMLElement>(`[data-slot="content"].${MODAL_CONTENT_CLASS}`)
  if (!content) {
    if (retry < 20) navSyncRaf = requestAnimationFrame(() => syncNavInset(retry + 1))
    return
  }
  const left = content.offsetLeft
  const right = left + content.offsetWidth
  // 弹窗两侧各留出「按钮 + 间距」；窗口太窄时空间不足，退化为贴屏幕边缘。
  // 此时浮钮会轻微压住弹窗边缘，但总比被挤出屏幕点不到强。
  navInset.left = Math.max(NAV_EDGE_MIN, Math.round(left - NAV_BUTTON_SPAN))
  navInset.right = Math.max(
    NAV_EDGE_MIN,
    Math.round(document.documentElement.clientWidth - right - NAV_BUTTON_SPAN)
  )
  observeContent(content)
}

/**
 * 变化侦测：正文落地/骨架屏换高度都会让遮罩层多出或少掉一条纵向滚动条（居中弹窗由遮罩层滚动）。
 *
 * 滚动条一出现就占掉遮罩内容盒的一条宽度，居中在里面的弹窗随之横移半条滚动条（实测 15px 滚动条
 * 横移 7.5px）。只在打开、切篇那一刻量一次几何是量不到这次横移的 —— 那一刻正文还没上屏、弹窗还是
 * 短的，量出来的落点等正文撑开后就偏了：左侧浮钮贴住弹窗、右侧离得远，两侧间距差正好一条滚动条。
 * 所以内容盒尺寸一变就按当前几何重量一次。
 */
let navObserver: ResizeObserver | null = null
let navObservedEl: HTMLElement | null = null

function observeContent(content: HTMLElement) {
  if (typeof ResizeObserver === 'undefined' || navObservedEl === content) return
  navObserver?.disconnect()
  navObservedEl = content
  navObserver = new ResizeObserver(() => syncNavInset())
  navObserver.observe(content)
}

function stopObservingContent() {
  navObserver?.disconnect()
  navObserver = null
  navObservedEl = null
}

/** 关闭时复位，避免下次打开先用上一次的落点闪一帧 */
function resetNavInset() {
  cancelAnimationFrame(navSyncRaf)
  stopObservingContent()
  navInset.left = NAV_EDGE_MIN
  navInset.right = NAV_EDGE_MIN
}

/**
 * 入场动画结束后才露出浮钮。
 *
 * 浮钮已经是弹窗内容（content）的 fixed 子元素，而入场动画正是 content 自身的 scale(.95→1)：
 * 动画期间 content 会成为 fixed 子元素的包含块，浮钮会被按「相对弹窗」而非「相对视口」摆放，
 * 位置会瞬时跑偏，所以先不渲染，等 after:enter 再显示。
 * 万一该事件没来（例如动画被跳过）则由定时器兜底，避免浮钮一直不出现。
 * 监听名必须写成 @after:enter：UModal 抛的是带冒号的 after:enter，写成 @after-enter 收不到。
 */
const navRevealed = ref(false)
let navRevealTimer = 0

function revealNav() {
  clearTimeout(navRevealTimer)
  navRevealed.value = true
}

// 打开/关闭、弹窗宽度设置变化时重新对齐；窗口尺寸变化走 resize 监听。
// 整块只在客户端注册：浮钮本就不参与 SSR，服务端没有 rAF 与视口几何。
if (import.meta.client) {
  // flush: 'post' 让首次量测落在本轮回调后的 DOM 更新之后：弹窗内容与浮钮同批挂载，
  // 量到之后才绘制，浮钮不会先用兜底落点在屏幕边缘闪一帧。
  // isFullscreen 一并监听：小屏↔桌面的临界切换（浮钮隐藏↔出现）也要重新量，
  // 否则从窄窗口拉宽回来时，浮钮会停在「全屏兜底」的贴屏位置。
  watch([isOpen, isFullscreen, () => settings.value.entryModalSize, () => currentEntry.value?.id], ([open]) => {
    clearTimeout(navRevealTimer)
    if (open) {
      syncNavInset()
      // after:enter 的兜底：事件没来也要能露出浮钮（动画只有 200ms，等 400ms 足够）
      navRevealTimer = window.setTimeout(revealNav, 400)
    } else {
      resetNavInset()
      navRevealed.value = false
    }
  }, { immediate: true, flush: 'post' })

  const onViewportResize = () => syncNavInset()
  window.addEventListener('resize', onViewportResize)
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onViewportResize)
    clearTimeout(navRevealTimer)
    cancelAnimationFrame(navSyncRaf)
    stopObservingContent()
  })
}

/**
 * 弹窗顶栏标题显示「订阅源名字」而非文章标题（文章标题已在正文区内展示）。
 * feed.title 已由 enrichEntries 换成用户在订阅列表里设置的名字（与侧边栏一致），
 * 仅当该源在本地完全没有数据时 title 为空，此时回退到文章标题，避免顶栏空白。
 */
const modalTitle = computed(() => currentEntry.value?.feed?.title || currentEntry.value?.title)
</script>

<template>
  <UModal
    v-model:open="isOpen"
    :title="modalTitle"
    :fullscreen="isFullscreen"
    :scrollable="isScrollable"
    :ui="modalUi"
    @after:enter="revealNav"
  >
    <template #body>
      <!--
        全屏（手机恒定全屏，桌面选全屏档也是）：Swiper 三槽划卡。
        两条正文分支都挂 stopPointerDownPropagation，原因见该函数。
      -->
      <div
        v-if="isFullscreen"
        class="article-swiper relative h-full"
        @pointerdown="stopPointerDownPropagation"
      >
        <ClientOnly>
          <!--
            划卡只认触屏：Swiper 的 simulateTouch 默认把鼠标拖动也当手势，并在 pointerdown 上
            preventDefault，桌面端鼠标拖选正文因此被吃掉。关掉它，鼠标拖动恢复成正常的文本选中；
            桌面翻页走浮钮与 ←/→ 键（触屏滑动不受影响），grabCursor 也随之失效，不再设置。
          -->
          <SwiperView
            :slides-per-view="1"
            :space-between="0"
            :speed="SWIPE_SPEED"
            :simulate-touch="false"
            :threshold="12"
            class="h-full"
            @swiper="onSwiperReady"
            @transition-end="onTransitionEnd"
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
                <EntryDetailSkeleton v-if="isLoading(slot.raw)" />
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
        class="relative min-h-full"
        @pointerdown="stopPointerDownPropagation"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <!--
          全文未到位时只显示骨架屏：投影（只有标题）不上屏，否则框体会先塌再弹。
          外层 div 只负责给 :key，切换条目/加载态时由 .entry-fade 做交叉淡入淡出。
        -->
        <Transition name="entry-fade">
          <div :key="detailViewKey">
            <EntryDetailSkeleton
              v-if="detailLoading"
              :height="detailSkeletonHeight"
            />
            <EntryDetail
              v-else-if="detailEntry"
              :entry="detailEntry"
            />
          </div>
        </Transition>
      </div>

      <!--
        电脑端：贴近弹窗左右边缘的上一篇/下一篇浮钮；小屏不渲染，改用触屏滑动。
        必须挂在弹窗内容里（而不是 Teleport 到 body）：reka-ui 的 DismissableLayer 按
        pointerdown 是否落在 content 子树内判断「点击了弹窗外部」，放在外面的浮钮会被当成
        外部点击，一点就顺带把弹窗关掉。位置用 fixed 固定在视口垂直中央（见 navInset）。
      -->
      <div
        v-if="isOpen && !isSmallScreen && navRevealed"
        class="pointer-events-none fixed inset-y-0 z-[70] flex items-center justify-between"
        :style="{ left: `${navInset.left}px`, right: `${navInset.right}px` }"
      >
        <UButton
          square
          size="lg"
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
            class="size-6"
          />
        </UButton>
        <UButton
          square
          size="lg"
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
            class="size-6"
          />
        </UButton>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <div class="flex items-center gap-1">
          <!--
            已读 / 未读与收藏都只作用于当前这篇：打开任意一篇时已由 watch 自动标为已读，
            这里给的是「标回未读」与「收藏」这两个手动动作；按钮状态直接读当前条目的字段。
          -->
          <!-- 同一套记号：图标与配色沿用列表页「只看未读」开关（见 EntryReaderPane 里的注释） -->
          <UButton
            v-if="currentEntry"
            :icon="currentEntry.read ? 'i-lucide-circle' : 'i-lucide-circle-dot'"
            :color="currentEntry.read ? 'neutral' : 'primary'"
            :variant="currentEntry.read ? 'ghost' : 'soft'"
            :aria-label="currentEntry.read ? '标为未读' : '标为已读'"
            :title="currentEntry.read ? '标为未读' : '标为已读'"
            :loading="readBusy"
            size="sm"
            @click="toggleRead"
          />
          <UButton
            v-if="currentEntry"
            icon="i-lucide-star"
            :color="currentEntry.starred ? 'warning' : 'neutral'"
            :variant="currentEntry.starred ? 'soft' : 'ghost'"
            :aria-label="currentEntry.starred ? '取消收藏' : '收藏'"
            :aria-pressed="currentEntry.starred === true"
            :title="currentEntry.starred ? '取消收藏' : '收藏'"
            :loading="savedBusy"
            size="sm"
            @click="toggleStar"
          />
          <UButton
            v-if="currentEntry"
            :to="currentEntry.url"
            target="_blank"
            label="阅读原文"
            icon="i-lucide-external-link"
            variant="outline"
            size="sm"
          />
        </div>
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

/* 正文切换的交叉淡入淡出：新内容正常占位（框体高度即时到位），
   退场层改为绝对定位铺满正文区并裁切，不参与撑高，因此不会出现空窗或高度反复。
   宽屏的常驻阅读栏用的是同一套类名，样式在这里（非 scoped，全局生效） */
.entry-fade-enter-active,
.entry-fade-leave-active {
  transition: opacity 0.18s ease;
}

.entry-fade-enter-from,
.entry-fade-leave-to {
  opacity: 0;
}

.entry-fade-leave-active {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
