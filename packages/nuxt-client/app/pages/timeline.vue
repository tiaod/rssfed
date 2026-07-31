<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const db = useCouchDb()
const pouch = usePouchDb()
const entries = ref<any[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    // 获取用户订阅列表
    const subs = await db.listSubscriptions()
    const feedIds = subs.map(s => s.id)

    if (feedIds.length === 0) {
      loading.value = false
      return
    }

    // 启动所有订阅源的 PouchDB 同步
    for (const feedId of feedIds) {
      pouch.syncFeed(feedId)
    }

    // 等待首次同步完成
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 从本地 PouchDB 查询条目
    entries.value = await pouch.queryEntries(feedIds, 50)
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="时间线">
        <template #right>
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
        <ULoading />
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
        base-path="/rss/feed"
      />
    </template>
  </UDashboardPanel>
</template>
