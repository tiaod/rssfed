<script setup lang="ts">
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'
import ListActionsBar from '~/components/ListActionsBar.vue'
import type { SubscriptionItem } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const route = useRoute()
const category = route.params.category as string

const pouch = usePouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

// 该分组下的订阅源（与导航栏的分类匹配规则一致：trim 后精确匹配）
const groupFeeds = computed(() =>
  (feeds.value ?? []).filter(feed => (feed.category?.trim() || '') === category)
)

const feedTitleMap = computed(() =>
  Object.fromEntries(groupFeeds.value.map(feed => [feed.id, feed.title]))
)

// 条目数据与同步刷新策略：同步只把新数据拉到本地并累计成「已同步 N 条」提示，一个字都不动
// 列表；用户点「查看」才重新查一次本地库、整体换成最新并回到顶部（见 useSyncedEntryList）。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew,
  applyNewIfSyncAddedNothing
} = useSyncedEntryList({
  // 从集中库查询该分组所有订阅源的条目，并补充分组内 feed 标题便于列表展示来源
  query: async (limit) => {
    const result = await pouch.queryGroupEntries(groupFeeds.value.map(feed => feed.id), limit)
    return result.map(entry => ({
      ...entry,
      feed: { ...entry.feed, title: feedTitleMap.value[entry.feedId] ?? '' }
    }))
  },
  syncedDocs: () => groupFeeds.value.reduce((n, feed) => n + (pouch.syncedDocsByFeed[feed.id] ?? 0), 0)
})

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(() => grow())
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

// 提示条是浮层（盖在列表顶部、不占布局），按滚动方向让位——下滑收起、上滑或回顶部露出
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef)

// 列表视图：分组默认 -> 全局默认；切换按钮只改本次会话，不落盘
const { view, overridden, setView, resetView } = useGroupView(category)

// 「全部标记为已读」：只标当前已加载的这批（见 useMarkAllRead）
const markAllRead = useMarkAllRead(entries)

onMounted(async () => {
  try {
    feeds.value = await pouch.listSubscriptions()
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载分组失败')
    loading.value = false
    return
  }

  // 不自动同步：数据来自集中库（时间线页已增量同步），需要最新时点导航栏同步按钮
  await load()
  loading.value = false
})

// 组内任一源同步完成时累计「已同步 N 条」；列表不动，等用户点提示条
watch(
  () => groupFeeds.value.map(feed => pouch.syncStatuses[feed.id]?.version ?? 0).join(','),
  () => refreshFromSync()
)
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar :title="category">
        <!-- 分组规模是「这个页面是什么」的一部分，跟标题放一起；右侧只留动作 -->
        <template #trailing>
          <UButton
            v-if="loading"
            loading
            variant="ghost"
            color="neutral"
            size="sm"
          >
            加载中…
          </UButton>
          <span
            v-else
            class="shrink-0 text-sm text-muted"
          >
            {{ groupFeeds.length }} 个订阅源
          </span>
        </template>

        <template #right>
          <ListViewSwitcher
            :view="view"
            :overridden="overridden"
            @update:view="setView"
            @reset="resetView"
          />
          <ListActionsBar
            :feed-ids="groupFeeds.map(f => f.id)"
            :entry-count="entries.length"
            @synced="applyNewIfSyncAddedNothing"
            @mark-all-read="markAllRead"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
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
          v-if="error"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-alert-circle"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            {{ error }}
          </p>
        </div>

        <div
          v-else-if="!loading && groupFeeds.length === 0"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-folder-open"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            该分组下暂无订阅源
          </p>
          <UButton
            to="/"
            variant="soft"
            color="neutral"
            size="sm"
          >
            返回主页
          </UButton>
        </div>

        <div
          v-else-if="!entries.length && !loading"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-file-text"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            暂无条目
          </p>
        </div>

        <!-- listAnchorRef 供用户点「查看」时定位滚动容器并回到顶部 -->
        <!-- 列表交给 ScrollArea 虚拟化，需要确定高度：容器撑满，列表占剩余空间 -->
        <EntryList
          v-else
          class="min-h-0 flex-1"
          :view="view"
          :entries="entries"
          :load-more="loadMore"
          :has-more="hasMoreGetter"
          show-feed
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
