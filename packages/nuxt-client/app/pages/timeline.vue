<script setup lang="ts">
import type { SubscriptionItem } from '~/composables/useCouchDb'

definePageMeta({
  layout: 'default'
})

const pouch = usePouchDb()
const subs = ref<SubscriptionItem[]>([])
const feedIds = computed(() => subs.value.map(s => s.id))
const entries = ref<any[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// 从本地 PouchDB 查询所有订阅源的条目
async function refreshEntries() {
  if (feedIds.value.length === 0) return
  entries.value = await pouch.queryEntries(feedIds.value, 50)
}

onMounted(async () => {
  try {
    // 获取用户订阅列表
    subs.value = await pouch.listSubscriptions()

    if (feedIds.value.length === 0) {
      loading.value = false
      return
    }

    // 启动所有订阅源的 PouchDB 同步；首次查询可能为空，同步完成后通过 watch 自动刷新
    for (const feedId of feedIds.value) {
      pouch.syncFeed(feedId)
    }
    await refreshEntries()
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
})

// 任一订阅源同步到新数据时自动刷新，避免刚订阅后条目尚未同步完成的空列表
watch(
  () => feedIds.value.map(id => pouch.syncStatuses[id]?.version ?? 0),
  () => refreshEntries()
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
