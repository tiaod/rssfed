<script setup lang="ts">
import type { SubscriptionItem } from '~/composables/useCouchDb'
import type { FeedSubscriptionItem } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const api = useApi()
const pouch = usePouchDb()
const subs = ref<SubscriptionItem[]>([])
const feedIds = computed(() => subs.value.map(s => s.id))
const entries = ref<any[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// 从集中库一次查询所有订阅源的最新条目
async function refreshEntries() {
  if (feedIds.value.length === 0) return
  entries.value = await pouch.queryTimeline(50)
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
        createdAt: s.createdAt,
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
        lastNewEntryAt: s.lastNewEntryAt,
      })))
    } else {
      for (const feedId of feedIds.value) {
        pouch.syncFeed(feedId)
      }
    }
    await refreshEntries()
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
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

      <div v-else-if="loading" class="flex justify-center py-12">
        <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-muted" />
      </div>

      <div v-else-if="!entries.length" class="flex flex-col items-center py-12 gap-4">
        <UIcon name="i-lucide-inbox" class="size-12 text-muted" />
        <p class="text-muted">暂无条目，先订阅一些 RSS 源吧</p>
        <UButton to="/" variant="outline" color="neutral">
          去发现订阅源
        </UButton>
      </div>

      <EntryList
        v-else
        :entries="entries"
      />
    </template>
  </UDashboardPanel>
</template>
