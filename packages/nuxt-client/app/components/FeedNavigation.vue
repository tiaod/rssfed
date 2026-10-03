<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import type { SubscriptionItem } from '~/types/rss'
import type { FeedNavigationMenuItem } from '~/composables/useFeedNavigation'
import { subscriptionsEqual } from '~/utils/subscriptionsEqual'
// 显式导入而不是依赖自动导入：项目内 profile.vue / SubscriptionManager.vue 也是这么用的，
// 组件清单扫描不到时不会静默退化成「Failed to resolve component」
import FeedIcon from '~/components/FeedIcon.vue'

const props = defineProps<{
  collapsed?: boolean
  /**
   * 只滚动订阅源列表（侧边栏固定头部时用）。
   * 关闭时退回「整块内容跟着侧边栏一起滚」，供高度不足的小屏 / 横屏使用，
   * 避免列表被固定的头部与底部挤成一条缝。
   */
  scrollable?: boolean
}>()

const api = useApi()
const toast = useToast()
const pouch = usePouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const error = ref<string | null>(null)

// ── 添加订阅 ──
const addOpen = ref(false)
const feedUrl = ref('')
const submitting = ref(false)
const addError = ref<string | null>(null)

// feed 图标不再在这里批量加载：交给 FeedIcon 按可见性懒加载（见 script 末尾的 slot）

/**
 * 从本地用户状态库加载订阅列表。
 *
 * 增量：user-state 库同时承载订阅与已读/收藏，标记一次已读就会让同步版本递增并触发本函数；
 * 内容没变就直接跳过赋值，否则 feeds 换成新数组会让 menuItems 重算、整棵导航菜单重渲染
 * （300 项实测约 30ms），而这类触发绝大多数与订阅无关。
 */
async function loadFeeds() {
  try {
    const next = await pouch.listSubscriptions()
    if (!subscriptionsEqual(feeds.value, next)) feeds.value = next
    error.value = null
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载订阅失败')
  }
}

/** 从菜单项取出 FeedIcon 需要的字段（自定义字段见 useFeedNavigation） */
function feedIdOf(item: unknown): string {
  return (item as FeedNavigationMenuItem | undefined)?.feedId ?? ''
}

function feedTextOf(item: unknown): string {
  return (item as FeedNavigationMenuItem | undefined)?.fallbackText ?? 'R'
}

onMounted(() => {
  void loadFeeds()
})

// 用户状态库（订阅列表）同步版本递增时重新加载侧边栏。
// syncNow 会先暂停用户状态库的 live 同步、一次性复制后恢复，期间拉取的远端订阅
// 变化（新增/改名/分类）不会实时推给侧边栏，这里在同步完成后重新读取订阅列表。
// 防抖：恢复 live 同步会再次触发版本变化，合并为一次刷新。
let feedsTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => pouch.syncStatuses['__user_state__']?.version ?? 0,
  () => {
    if (feedsTimer) clearTimeout(feedsTimer)
    feedsTimer = setTimeout(() => {
      feedsTimer = null
      void loadFeeds()
    }, 200)
  }
)

const route = useRoute()

/** 当前路由对应的订阅 id / 分类：决定侧边栏默认展开哪个分组 */
const activeFeedId = computed(() => {
  // 读某一篇时的地址是 /rss/feed/:id/entry/:entryId（见 useEntryRoute）：后面那段不该混进 id
  const feedMatch = route.path.match(/^\/rss\/feed\/([^/]+)(?:\/entry\/[^/]+)?$/)
  if (feedMatch?.[1]) return decodeURIComponent(feedMatch[1])
  const botMatch = route.path.match(/^\/bots\/([^/]+)\/posts$/)
  if (botMatch?.[1]) return `bot:${botMatch[1]}`
  return null
})
const activeCategory = computed(() => {
  const match = route.path.match(/^\/rss\/group\/(.+)$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
})

const { menuItems, hasFeeds, activeCategoryGroupValue } = useFeedNavigation(
  computed(() => feeds.value),
  { activeFeedId, activeCategory }
)

/**
 * 展开的分组（受控）。
 *
 * 默认全折叠：几百个订阅源全展开会让几百个菜单项同时进 DOM，实测 433 项约
 * 120–150ms 的组件创建 + 布局成本，而用户一眼能看的只有十几个。
 * 只把当前路由所在分组展开，其余由用户点击展开；路由变化时把新分组并入，
 * 不会折叠用户已手动打开的分组。
 */
const openGroups = ref<string[]>([])
watch(activeCategoryGroupValue, (value) => {
  if (value && !openGroups.value.includes(value)) {
    openGroups.value = [...openGroups.value, value]
  }
}, { immediate: true })

// ── 底部渐隐（代替列表与用户区之间的分割线，参考 DeepSeek 侧边栏）──
//
// 列表还有内容被挡住时，底部盖一层「侧边栏背景色 → 透明」的渐变把内容淡出；
// 滚到底就撤掉，免得最后一项永远看不清。只在「列表自己滚」（scrollable）时生效：
// 紧凑模式下整块内容跟着侧边栏一起滚，固定位置的渐变会盖住滚动中的内容。
const listEl = ref<HTMLElement | null>(null)
const listContentEl = ref<HTMLElement | null>(null)
const showFade = ref(false)
let listObserver: ResizeObserver | null = null

function updateFade() {
  const el = listEl.value
  showFade.value = !!(
    props.scrollable
    && el
    && el.scrollHeight - el.clientHeight - el.scrollTop > 1
  )
}

/**
 * 容器尺寸（窗口缩放、侧边栏拖宽）和内容高度（订阅源增减、分组展开）都会改变
 * 「是否还有内容被挡住」，两个盒子都观察，避免只在滚动时才更新。
 */
function observeList() {
  if (typeof ResizeObserver === 'undefined') {
    updateFade()
    return
  }
  if (!listObserver) listObserver = new ResizeObserver(() => updateFade())
  listObserver.disconnect()
  if (listEl.value) listObserver.observe(listEl.value)
  if (listContentEl.value) listObserver.observe(listContentEl.value)
  updateFade()
}

// flush: 'post'：ClientOnly 的插槽要到客户端挂载后才有真实 DOM，等 DOM 更新完再观察
watch([listEl, listContentEl, () => props.scrollable], observeList, { flush: 'post' })

onBeforeUnmount(() => {
  listObserver?.disconnect()
  listObserver = null
})

async function addFeed() {
  const url = feedUrl.value.trim()
  if (!url || submitting.value) return
  submitting.value = true
  addError.value = null
  try {
    // 1. 后端解析并注册该订阅源，写入 per-feed 库并触发首轮抓取
    const { feedId, title } = await api.feeds.discover(url)
    // 源没给标题时退回 URL，避免订阅列表里出现空标题
    const feedTitle = title ?? url
    // 2. 在本地 PouchDB 写入订阅关系（自动同步到远端，出现在侧边栏）
    await pouch.addSubscription(feedId, { title: feedTitle })
    toast.add({ title: '订阅成功', description: feedTitle, color: 'success' })
    addOpen.value = false
    feedUrl.value = ''
    feeds.value = await pouch.listSubscriptions()
  } catch (e: unknown) {
    addError.value = errorMessage(e, '订阅失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div :class="scrollable ? 'flex min-h-0 flex-1 flex-col' : ''">
    <ClientOnly>
      <div
        v-if="error"
        class="px-2"
      >
        <p class="text-xs text-red-500">
          {{ error }}
        </p>
      </div>

      <template v-else>
        <!-- 固定区：区块标题 + 添加订阅入口（靠右的加号按钮；折叠成图标时只留按钮） -->
        <div
          class="flex shrink-0 items-center gap-2 px-2.5 py-1.5"
          :class="collapsed ? 'justify-center' : 'justify-between'"
        >
          <span
            v-if="!collapsed"
            class="text-xs/5 font-semibold text-highlighted"
          >
            订阅源
          </span>
          <UTooltip
            text="添加订阅源"
            :disabled="!collapsed"
          >
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-plus"
              size="xs"
              square
              aria-label="添加订阅源"
              @click="() => { addOpen = true }"
            />
          </UTooltip>
        </div>

        <!--
          滚动区：订阅源列表（relative 供底部渐隐定位）。

          负边距抵消侧边栏 body 的 px-4 py-2，让滚动区直接铺满侧边栏，四周的空白
          改成列表内容自己的内边距（见下面的 px-4 pb-2）—— 于是滚动条、底部渐隐、
          以及滚出视野的条目都贴在侧边栏边缘，而不是被 body 的内边距框成一个方框。

          这里按 body 的默认 px-4 / py-2 成对写：负边距退多少，内容内边距就补回多少。
          不再镜像抽屉模式 body 的 sm:px-6 —— 抽屉在本项目没有入口，侧边栏只在 lg 起
          出现（那时 body 就是 px-4），多一套断点只会让两边一旦不同步就错位。
        -->
        <div
          class="relative flex min-w-0 flex-col"
          :class="scrollable ? 'min-h-0 flex-1 -mx-4 -mb-2' : ''"
        >
          <div
            ref="listEl"
            class="min-h-0"
            :class="scrollable ? 'flex-1 overflow-y-auto' : ''"
            @scroll.passive="updateFade"
          >
            <div
              ref="listContentEl"
              :class="scrollable ? 'px-4 pb-2' : ''"
            >
              <UNavigationMenu
                v-model="openGroups"
                :collapsed="collapsed"
                :items="menuItems"
                orientation="vertical"
                tooltip
                popover
              >
                <!--
                  feed 项（useFeedNavigation 里标了 slot: 'feed'）的图标：
                  由 FeedIcon 在进入视口时才请求，未就位时显示首字母占位。
                  旧实现会对每个订阅源同步调 getFeedImageUrl，订阅多时一次性占满主线程。
                -->
                <template #feed-leading="{ item }">
                  <FeedIcon
                    :feed-id="feedIdOf(item)"
                    :fallback-text="feedTextOf(item)"
                    :load-icon="pouch.getFeedImageUrl"
                  />
                </template>
              </UNavigationMenu>

              <div
                v-if="!hasFeeds"
                class="px-2"
              >
                <p class="text-xs text-muted">
                  暂无订阅
                </p>
              </div>
            </div>
          </div>

          <!--
            底部渐隐：用侧边栏自身的背景色（--ui-bg）渐变到透明，替代与用户区之间的分割线。
            高度按 DeepSeek 侧边栏的观感取 3rem（约一到两行列表项）。
          -->
          <div
            v-if="showFade"
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-[var(--ui-bg)] to-transparent"
          />
        </div>
      </template>
    </ClientOnly>

    <!-- 添加订阅弹窗 -->
    <UModal
      v-model:open="addOpen"
      title="添加订阅源"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <p class="text-sm text-muted mb-3">
          输入 RSS / Atom 订阅地址，解析成功后即可阅读其最新条目。
        </p>

        <UForm @submit="addFeed">
          <UFormField
            label="RSS URL"
            required
          >
            <UInput
              v-model="feedUrl"
              type="url"
              placeholder="https://example.com/feed.xml"
              class="w-full"
            />
          </UFormField>
        </UForm>

        <UAlert
          v-if="addError"
          color="error"
          variant="soft"
          :title="addError"
          class="mt-3"
        />
      </template>

      <template #footer="{ close }">
        <UButton
          variant="outline"
          color="neutral"
          @click="close"
        >
          取消
        </UButton>
        <UButton
          color="primary"
          :loading="submitting"
          :disabled="!feedUrl.trim()"
          @click="addFeed"
        >
          订阅
        </UButton>
      </template>
    </UModal>
  </div>
</template>
