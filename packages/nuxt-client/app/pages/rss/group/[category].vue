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

// 条目数据与同步刷新策略：后台同步到的新条目先累计成「N 条新内容」提示，用户点了才上屏，
// 避免把正在读的内容推走（用户主动点同步按钮时则直接上屏，见 isUserDrivenSync）。
const {
  entries, pendingCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyPending
} = useSyncedEntryList({
  // 从集中库查询该分组所有订阅源的条目，并补充分组内 feed 标题便于列表展示来源
  query: async (limit) => {
    const result = await pouch.queryGroupEntries(groupFeeds.value.map(feed => feed.id), limit)
    return result.map(entry => ({
      ...entry,
      feed: { ...entry.feed, title: feedTitleMap.value[entry.feedId] ?? '' }
    }))
  }
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

// 同步完成 / 手动同步后重新查询；新条目先进提示条，用户主动同步时直接上屏
watch(
  () => groupFeeds.value.map(feed => pouch.syncStatuses[feed.id]?.version ?? 0).join(','),
  () => void refreshFromSync(pouch.isUserDrivenSync())
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
        <!-- listAnchorRef 供应用「N 条新内容」时定位滚动容器并回到顶部 -->
        <div ref="listAnchorRef">
          <NewEntriesBanner
            v-if="pendingCount"
            :count="pendingCount"
            @apply="applyPending"
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
