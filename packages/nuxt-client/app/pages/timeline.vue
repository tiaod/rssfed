<script setup lang="ts">
import type { SubscriptionItem, FeedSubscriptionItem } from '~/types/rss'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import ListActionsBar from '~/components/ListActionsBar.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'

definePageMeta({
  layout: 'default'
})

const api = useApi()
const pouch = usePouchDb()
const subs = ref<SubscriptionItem[]>([])
const feedIds = computed(() => subs.value.map(s => s.id))
const error = ref<string | null>(null)

// 条目数据与同步刷新策略：同步只把新数据拉到本地并累计成「已同步 N 条」提示，一个字都不动
// 列表；用户点「查看」才重新查一次本地库、整体换成最新并回到顶部——同步因此永远不会把正在
// 读的内容推走。syncedDocs 把计数限定在本页订阅源的范围内，别的源同步不该惊动这个列表。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew,
  applyNewIfSyncAddedNothing
} = useSyncedEntryList({
  query: limit => pouch.queryTimeline(limit),
  syncedDocs: () => feedIds.value.reduce((n, id) => n + (pouch.syncedDocsByFeed[id] ?? 0), 0)
})

// 首屏要等本地库重查一次
const loading = ref(true)

// 「只看未读」：不再过滤已加载的窗口，而是按游标深扫未读 —— 扫描只合已读态、不做 enrich，
// 凑够一屏才 enrich 上屏（见 useUnreadFilter）。「全部标记为已读」作用在可见的那批上。
const {
  unreadOnly, visibleEntries, visibleHasMore, loadMoreVisible, toggleUnreadOnly, probing, scannedCount
} = useUnreadFilter({
  entries,
  hasMore: () => hasMore.value,
  grow: () => grow(),
  scan: (cursor, limit, notAfter) => pouch.scanTimelinePage(cursor, limit, notAfter),
  enrich: list => pouch.enrichEntries(list)
})
const markAllRead = useMarkAllRead(visibleEntries)

// 滚动到底部附近时加载下一批；loadMore 同时供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(loadMoreVisible)

// 提示条是浮层（盖在列表顶部、不占布局），按滚动方向让位——下滑收起、上滑或回顶部露出
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef)

// 列表视图：默认取全局设置（默认瀑布流）；切换按钮只改本次会话，不落盘
const { view, overridden, setView, resetView } = useTimelineView()

onMounted(async () => {
  try {
    // 获取订阅列表：优先远端（含 lastNewEntryAt，用于增量同步判断），失败回退本地
    let remoteSubs: FeedSubscriptionItem[] | null = null
    try {
      remoteSubs = await api.feeds.subscriptions()
    } catch {
      // 离线：回退本地订阅列表
    }

    if (remoteSubs) {
      subs.value = remoteSubs.map(s => ({
        id: s.feedId,
        title: s.title,
        siteUrl: s.siteUrl,
        description: s.description,
        image: s.image,
        category: s.category,
        createdAt: s.createdAt
      }))
    } else {
      subs.value = await pouch.listSubscriptions()
    }

    if (feedIds.value.length === 0) {
      loading.value = false
      return
    }

    // 增量同步：只同步「上次同步后有过新内容」或「从未同步过」的源；
    // 离线时回退为全量同步本地缓存的源
    if (remoteSubs) {
      await pouch.syncFeedsIfChanged(remoteSubs.map(s => ({
        feedId: s.feedId,
        lastNewEntryAt: s.lastNewEntryAt
      })))
    } else {
      for (const feedId of feedIds.value) {
        pouch.syncFeed(feedId)
      }
    }
    await load()
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载失败')
  } finally {
    loading.value = false
  }
})

// 任一订阅源同步完成时累计「已同步 N 条」。列表不动：新条目什么时候进列表由用户点提示条决定
// （见 useSyncedEntryList），因此这里不需要判断这次同步是不是用户按的按钮。
watch(
  () => feedIds.value.map(id => pouch.syncStatuses[id]?.version ?? 0).join(','),
  () => refreshFromSync()
)
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar title="时间线">
        <template #right>
          <!-- 页面状态排在动作之前（切换视图按钮的左边） -->
          <UButton
            v-if="loading"
            loading
            variant="ghost"
            color="neutral"
            size="sm"
          >
            加载中…
          </UButton>

          <ListViewSwitcher
            :view="view"
            :overridden="overridden"
            @update:view="setView"
            @reset="resetView"
          />
          <ListActionsBar
            :entry-count="visibleEntries.length"
            :unread-only="unreadOnly"
            @toggle-unread-only="toggleUnreadOnly"
            @synced="applyNewIfSyncAddedNothing"
            @mark-all-read="markAllRead"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- 错误只做提示，不遮挡已有内容：从上次的列表恢复时照样能接着读 -->
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error"
        class="mb-4"
      />

      <div
        ref="listAnchorRef"
        class="relative flex h-full min-h-0 flex-col"
      >
        <!-- 浮层提示条：盖在滚动区顶部，不占布局，按滚动方向让位 -->
        <NewEntriesBanner
          floating
          :count="newCount"
          :visible="bannerVisible"
          @apply="applyNew"
        />

        <div
          v-if="loading"
          class="flex justify-center py-12"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-8 animate-spin text-muted"
          />
        </div>

        <!-- 「只看未读」的空态：扫描中 / 扫完这批没找到 / 真的没有，三种情况分开说 -->
        <NoUnreadState
          v-else-if="unreadOnly && !visibleEntries.length"
          :probing="probing"
          :scanned="scannedCount"
          :has-more="visibleHasMore()"
          @scan-more="loadMoreVisible"
          @show-all="toggleUnreadOnly"
        />

        <div
          v-else-if="!visibleEntries.length"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-inbox"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            暂无条目，先订阅一些 RSS 源吧
          </p>
          <UButton
            to="/"
            variant="outline"
            color="neutral"
          >
            去发现订阅源
          </UButton>
        </div>

        <!-- listAnchorRef 供用户点「查看」时定位滚动容器并回到顶部 -->
        <!-- 列表交给 ScrollArea 虚拟化，需要确定高度：容器撑满，列表占剩余空间 -->
        <EntryList
          v-else
          class="min-h-0 flex-1"
          :view="view"
          :entries="visibleEntries"
          :load-more="loadMore"
          :has-more="visibleHasMore"
          show-feed
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
