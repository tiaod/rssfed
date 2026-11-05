<script setup lang="ts">
import type { SubscriptionItem } from '~/types/rss'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import ListActionsBar from '~/components/ListActionsBar.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'

definePageMeta({
  layout: 'default'
})

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
  syncedDocs: () => pouch.syncedEntryCount(),
  // 同步也会带来删除（源库裁剪随复制传播）：列表现场剔除已失效的行，避免点开 404
  removedIds: () => pouch.removedEntryIds
})

// 首屏策略：有本地缓存先上屏；没有才等优先同步（最多 5s），与单源 / 分组 / bot 页一致
// （见 useListFirstPaint）。时间线没有「本列表范围」，sync 只按本地订阅判空。
const { loading, renderFirstPaint } = useListFirstPaint({
  load,
  hasEntries: () => entries.value.length > 0,
  sync: async () => {
    // 没有订阅就没有可聚合的内容：别为一个空列表白等 5s
    if (feedIds.value.length === 0) return
    await pouch.syncPriority()
  }
})

// 「只看未读」：不再过滤已加载的窗口，而是按游标深扫未读 —— 扫描只合已读态、不做 enrich，
// 凑够一屏才 enrich 上屏（见 useUnreadFilter）。「全部标记为已读」作用在可见的那批上。
const {
  unreadOnly, visibleEntries, visibleHasMore, loadMoreVisible, resumeUnreadScan, toggleUnreadOnly,
  probing, scannedCount
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

onMounted(async () => {
  try {
    // 订阅列表只读本地（`subscription:*` 随 live 复制一起同步，离线也可用）；
    // 别的设备的增删改会由复制写进本地库，不需要在这里再问一次远端
    subs.value = await pouch.listSubscriptions()
    // 页面往返后「只看未读」开关可能仍是开的，补扫一轮，避免空态误报没有未读
    resumeUnreadScan()
    await renderFirstPaint()
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载失败')
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
