<script setup lang="ts">
import type { SubscriptionItem, FeedSubscriptionItem } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const api = useApi()
const pouch = usePouchDb()
const subs = ref<SubscriptionItem[]>([])
const feedIds = computed(() => subs.value.map(s => s.id))
const loading = ref(true)
const error = ref<string | null>(null)

// 条目数据与同步刷新策略：后台同步到的新条目先累计成「N 条新内容」提示，用户点了才上屏，
// 避免把正在读的内容推走；订阅源多时逐个同步完成会密集触发重查，用防抖合并成一次。
const {
  entries, pendingCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyPending
} = useSyncedEntryList({
  query: limit => pouch.queryTimeline(limit),
  debounceMs: 200
})

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { sentinelRef, loading: loadingMore, loadMore } = useInfiniteList(() => grow())
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

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

// 任一订阅源同步完成时重新查询。首屏之后拿到的新条目一律先进提示条（见 useSyncedEntryList），
// 只有用户主动点过同步按钮（isUserDrivenSync）才直接上屏——他此刻就是要看最新内容。
watch(
  () => feedIds.value.map(id => pouch.syncStatuses[id]?.version ?? 0).join(','),
  () => void refreshFromSync(pouch.isUserDrivenSync())
)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="时间线">
        <template #right>
          <SyncButton />
          <UButton
            v-if="loading"
            loading
            variant="ghost"
            color="neutral"
            size="sm"
          >
            加载中…
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error"
      />

      <div
        v-else-if="loading"
        class="flex justify-center py-12"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-8 animate-spin text-muted"
        />
      </div>

      <div
        v-else-if="!entries.length"
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
