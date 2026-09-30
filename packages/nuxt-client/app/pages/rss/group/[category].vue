<script setup lang="ts">
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
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew
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
const { sentinelRef, loading: loadingMore, loadMore } = useInfiniteList(() => grow())
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

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
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="category">
        <template #right>
          <SyncButton :feed-ids="groupFeeds.map(f => f.id)" />
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
            class="text-sm text-muted"
          >
            {{ groupFeeds.length }} 个订阅源
          </span>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
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

      <template v-else>
        <!-- listAnchorRef 供用户点「查看」时定位滚动容器并回到顶部 -->
        <div ref="listAnchorRef">
          <!-- 常驻挂载：展开 / 收起由组件内部过渡，列表跟着平滑平移 -->
          <NewEntriesBanner
            :count="newCount"
            @apply="applyNew"
          />
          <EntryList
            :entries="entries"
            :load-more="loadMore"
            :has-more="hasMoreGetter"
            show-feed
          />

          <!-- 无限滚动：哨兵进入视口触发加载下一批 -->
          <div
            ref="sentinelRef"
            class="h-px"
            aria-hidden="true"
          />
          <div
            v-if="loadingMore"
            class="flex justify-center py-6"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-5 animate-spin text-muted"
            />
          </div>
          <p
            v-else-if="!hasMore"
            class="py-6 text-center text-xs text-muted"
          >
            已加载全部条目
          </p>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
