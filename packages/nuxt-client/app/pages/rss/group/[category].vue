<script setup lang="ts">
import type { SubscriptionItem } from '~/composables/useCouchDb'
import type { RssEntry } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const route = useRoute()
const category = route.params.category as string

const pouch = usePouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const entries = ref<RssEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// 该分组下的订阅源（与导航栏的分类匹配规则一致：trim 后精确匹配）
const groupFeeds = computed(() =>
  (feeds.value ?? []).filter(feed => (feed.category?.trim() || '') === category)
)

const feedTitleMap = computed(() =>
  Object.fromEntries(groupFeeds.value.map(feed => [feed.id, feed.title]))
)

// 从本地 PouchDB 查询该分组所有订阅源的条目
async function refreshEntries() {
  const result = await pouch.queryEntries(groupFeeds.value.map(feed => feed.id), 50)
  // 补充分组内 feed 标题，便于条目列表展示来源
  entries.value = result.map(entry => ({
    ...entry,
    feed: { ...entry.feed, title: feedTitleMap.value[entry.feedId] ?? '' },
  }))
}

onMounted(async () => {
  try {
    feeds.value = await pouch.listSubscriptions()
  } catch (e: any) {
    error.value = e?.message ?? '加载分组失败'
    loading.value = false
    return
  }

  // 同步分组内所有 feed；首次查询可能为空，同步完成后通过 watch 自动刷新
  for (const feed of groupFeeds.value) {
    pouch.syncFeed(feed.id)
  }
  await refreshEntries()
  loading.value = false
})

// 同步过程中有新数据到达时重新查询
watch(
  () => groupFeeds.value.map(feed => pouch.syncStatuses[feed.id]?.version ?? 0).join(','),
  () => refreshEntries()
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
        <UIcon name="i-lucide-alert-circle" class="size-12 text-muted" />
        <p class="text-muted">{{ error }}</p>
      </div>

      <div
        v-else-if="!loading && groupFeeds.length === 0"
        class="flex flex-col items-center py-12 gap-4"
      >
        <UIcon name="i-lucide-folder-open" class="size-12 text-muted" />
        <p class="text-muted">该分组下暂无订阅源</p>
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
        <UIcon name="i-lucide-file-text" class="size-12 text-muted" />
        <p class="text-muted">暂无条目</p>
      </div>

      <EntryList
        v-else
        :entries="entries"
      />
    </template>
  </UDashboardPanel>
</template>
