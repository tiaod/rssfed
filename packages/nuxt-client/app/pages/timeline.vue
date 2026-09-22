<script setup lang="ts">
import type { SubscriptionItem } from '~/composables/useCouchDb'
import type { FeedSubscriptionItem, RssEntry } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const api = useApi()
const pouch = usePouchDb()
const subs = ref<SubscriptionItem[]>([])
const feedIds = computed(() => subs.value.map(s => s.id))
const entries = ref<RssEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// ── 无限滚动：查询窗口逐步增大，同步刷新时保留当前深度 ──
const PAGE_SIZE = 50
const MAX_ENTRIES = 10000 // 与集中库 find 上限一致，达到后不再加载
const displayLimit = ref(PAGE_SIZE)

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { sentinelRef, loading: loadingMore, hasMore, loadMore } = useInfiniteList(async () => {
  if (!hasMore.value) return false
  displayLimit.value += PAGE_SIZE
  await refreshEntries()
  return hasMore.value
})
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

// 从集中库一次查询所有订阅源的最新条目
async function refreshEntries() {
  if (feedIds.value.length === 0) return
  entries.value = await pouch.queryTimeline(displayLimit.value)
  // 返回条数达到窗口上限说明可能还有更多；触顶（达到 find 上限）则停止
  hasMore.value = entries.value.length >= displayLimit.value && displayLimit.value < MAX_ENTRIES
}

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
    await refreshEntries()
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载失败')
  } finally {
    loading.value = false
  }
})

// 任一订阅源同步到新数据时自动刷新，避免刚订阅后条目尚未同步完成的空列表。
// 防抖：订阅源很多时逐个完成同步会频繁触发全量重查，合并为一次刷新。
let refreshTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => feedIds.value.map(id => pouch.syncStatuses[id]?.version ?? 0).join(','),
  () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshEntries()
    }, 200)
  }
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
        <EntryList
          :entries="entries"
          :load-more="loadMore"
          :has-more="hasMoreGetter"
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
      </template>
    </template>
  </UDashboardPanel>
</template>
