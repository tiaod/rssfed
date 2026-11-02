<script setup lang="ts">
import type { SubscriptionItem } from '~/types/rss'
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
// 读的内容推走。时间线页就是全部订阅源，所以计数用全库口径（不传 feedIds）；
// 单源 / 分组 / bot 页要把范围限定成自己那些源（见 usePouchDb.syncedEntryCount）。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew,
  applyNewIfSyncAddedNothing
} = useSyncedEntryList({
  query: limit => pouch.queryTimeline(limit),
  syncedDocs: () => pouch.syncedEntryCount()
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
  scan: (cursor, limit) => pouch.scanTimelinePage(cursor, limit),
  enrich: list => pouch.enrichEntries(list)
})
const markAllRead = useMarkAllRead(visibleEntries)

// 滚动到底部附近时加载下一批；loadMore 同时供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(loadMoreVisible)

// 提示条是浮层（盖在列表顶部、不占布局），按滚动方向让位——下滑收起、上滑或回顶部露出
// 「只看未读」下整条收起：切进未读就是一次完整刷新（不受列表快照约束），待查看的条目此刻
// 已经上屏，再顶一条「已同步 N 条」纯属重复；计数不清零，切回全部时照旧出现
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef, { suppressed: unreadOnly })

// 列表视图：默认取全局设置（默认瀑布流）；切换按钮只改本次会话，不落盘
const { view, overridden, setView, resetView } = useTimelineView()

/**
 * 远端订阅集合校正 + 催一次聚合（后台执行，不参与首屏）。
 *
 * 订阅文档本地已经有一份（`subscription:{feedId}`，见 usePouchDb.listSubscriptions），
 * 打开列表时不必再等 `/api/feeds/subscriptions` 的往返：它只在本地滞后时（别的设备刚
 * 订阅/取消、回写还没同步到）才有校正价值。`lastNewEntryAt` 也不再参与增量判断
 * （服务端一次聚合全部订阅，见 syncFeedsIfChanged），这次请求因此可以整个让到后台。
 */
async function syncSubscriptionsInBackground(): Promise<void> {
  const beforeCount = feedIds.value.length
  try {
    const remoteSubs = await api.feeds.subscriptions()
    subs.value = remoteSubs.map(s => ({
      id: s.feedId,
      title: s.title,
      siteUrl: s.siteUrl,
      description: s.description,
      image: s.image,
      category: s.category,
      createdAt: s.createdAt
    }))
    // 自动同步：服务端按它读到的订阅集合做增量聚合，客户端只负责「确保 live 复制在跑 +
    // 带节流地催一次」
    await pouch.syncFeedsIfChanged(remoteSubs.map(s => ({
      feedId: s.feedId,
      lastNewEntryAt: s.lastNewEntryAt
    })))
  } catch {
    // 离线：沿用本地订阅，仍然催一次（live 复制会在有网后自己补上）
    pouch.syncFeed()
    return
  }

  // 本地订阅此前是空的（还没从远端同步下来）：远端集合补上后补查一次，
  // 否则页面会一直停在「暂无条目」
  if (entries.value.length === 0 && feedIds.value.length > beforeCount) {
    await load()
    loading.value = false
  }
}

onMounted(async () => {
  try {
    // 订阅列表先读本地（离线可用，且随 live 复制已经就绪）：首屏不该等一次 HTTP
    subs.value = await pouch.listSubscriptions()
    // 远端校正与聚合催促让到后台：有缓存时一个请求都不等
    void syncSubscriptionsInBackground()

    if (feedIds.value.length === 0) return
    await load()
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载失败')
  } finally {
    loading.value = false
  }
})

// 时间线库有新的批次落库时累计「已同步 N 条」。列表不动：新条目什么时候进列表由用户点
// 提示条决定（见 useSyncedEntryList），因此这里不需要判断这次同步是不是用户按的按钮。
watch(pouch.timelineVersion, () => refreshFromSync())
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
