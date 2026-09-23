<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { usePouchSyncStatus } from '~/composables/usePouchDb'

/**
 * 侧边栏订阅源图标（进入视口才加载）。
 *
 * 背景：侧边栏条目可达数百个，而 `getFeedImageUrl` 每项都要读一次 FeedDoc、
 * 读一次附件 blob 再 `URL.createObjectURL`。实测 N=300 时把这批调用一次性打出去，
 * 主线程约被占用 40–45ms（createObjectURL ≈ 148µs/次是主要成本），
 * 打开侧边栏时表现为掉 3–4 帧。
 *
 * 做法：
 *   1. 只有进入视口（含 200px 余量）的项才请求图标，未命中的显示首字母占位；
 *   2. 全侧边栏共用一个 IntersectionObserver —— 每个菜单项一个实例本身就是开销；
 *   3. 该源同步到新数据后（图标附件此时才落到本地）由 syncStatuses 精确重试一次，
 *      不需要侧边栏整体重新加载。
 */

const props = defineProps<{
  /** 订阅业务 id（bot 订阅为 `bot:<botId>`）；空串表示该菜单项不是订阅项 */
  feedId?: string
  /** 图标就位前的首字母占位 */
  fallbackText?: string
  /**
   * 图标加载函数（由侧边栏注入）。
   * 走 prop 而不是在组件内调 usePouchDb()：几百个菜单项各构造一份 PouchDB
   * 操作闭包不划算，加载函数本身由侧边栏创建一次即可。
   */
  loadIcon: (feedId: string) => Promise<string | null>
}>()

const syncStatuses = usePouchSyncStatus()

/**
 * 观察目标必须是真实 DOM 元素：
 *   - 模板 ref 挂在 UAvatar（组件）上拿到的是组件实例，交给 IntersectionObserver
 *     会抛 "parameter 1 is not of type 'Element'"；
 *   - UAvatar 的 inheritAttrs 是 false，属性会透传到内部 img / fallback 上，
 *     根元素拿不到 data-slot，端到端检查就定位不到它。
 * 所以外面包一层 span 承载 ref 与 data-slot（flex 布局下不影响对齐）。
 */
const root = ref<Element | null>(null)
const src = shallowRef<string | null>(null)
/** 同一项的请求去重（同步版本变化会再次触发 load） */
let inFlight = false

// ── 共享 IntersectionObserver ──
let sharedObserver: IntersectionObserver | null = null
const enterCallbacks = new WeakMap<Element, () => void>()

function getObserver(): IntersectionObserver | null {
  // 老浏览器 / 测试环境没有 IntersectionObserver：直接加载，行为退回改动前
  if (typeof IntersectionObserver === 'undefined') return null
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        enterCallbacks.get(entry.target)?.()
      }
    }, {
      // 提前约一屏开始加载，滚动到时图标通常已经就位
      rootMargin: '200px 0px'
    })
  }
  return sharedObserver
}

function stopObserving() {
  const el = root.value
  if (!el) return
  enterCallbacks.delete(el)
  sharedObserver?.unobserve(el)
}

/** 请求图标；usePouchDb 内部按 feedId + _rev 缓存 blob URL，滚回不会重复读附件 */
async function load() {
  const id = props.feedId
  if (!id || src.value || inFlight) return
  inFlight = true
  try {
    const url = await props.loadIcon(id)
    // 菜单项按 index 复用：等待期间 feedId 可能已经换成别的源，别把图标贴错
    if (url && props.feedId === id) src.value = url
  } catch {
    // 无图标 / 附件尚未同步：保持文字占位，等同步版本变化或下次滚入时再试
  } finally {
    inFlight = false
  }
}

function startObserving() {
  if (!props.feedId) return
  const el = root.value
  if (!el) return
  const observer = getObserver()
  if (!observer) {
    void load()
    return
  }
  enterCallbacks.set(el, () => {
    void load()
  })
  observer.observe(el)
}

onMounted(startObserving)
onBeforeUnmount(stopObserving)

// 该源同步完成后重试：首次打开时 FeedDoc 与图标附件可能还没复制到本地
watch(
  () => syncStatuses[props.feedId ?? '']?.version ?? 0,
  () => {
    void load()
  }
)

// 菜单项按 index 复用，feedId 变了要换回占位并重新观察（同步版本 watch 也随之切换依赖）
watch(() => props.feedId, () => {
  src.value = null
  stopObserving()
  startObserving()
})
</script>

<template>
  <span
    ref="root"
    data-slot="feedIcon"
    class="shrink-0"
  >
    <!--
      size 必须与 UNavigationMenu 的 linkLeadingAvatarSize 主题默认值一致（2xs）——
      图标改由本组件渲染后，尺寸不再由 UNavigationMenu 内部决定，写错就直接表现为
      侧边栏图标大小变化。
    -->
    <UAvatar
      :src="src ?? undefined"
      :text="fallbackText || 'R'"
      color="neutral"
      size="2xs"
    />
  </span>
</template>
