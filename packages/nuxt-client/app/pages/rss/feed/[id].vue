<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string

const api = useApi()
const db = useCouchDb()
const pouch = usePouchDb()
const toast = useToast()
const feed = ref<any>(null)
const entries = ref<any[]>([])
const loading = ref(true)
const feedLoading = ref(true)

// 取消订阅
const unsubscribeOpen = ref(false)
const unsubscribing = ref(false)

async function unsubscribe() {
  unsubscribing.value = true
  try {
    await db.removeSubscription(feedId)
    toast.add({ title: '已取消订阅', color: 'success' })
    await navigateTo('/')
  } catch (e: any) {
    toast.add({ title: '取消订阅失败', description: e?.message ?? '未知错误', color: 'error' })
  } finally {
    unsubscribing.value = false
  }
}

onMounted(async () => {
  try {
    // 加载订阅源信息
    feed.value = await api.feeds.get(feedId)
  } catch {
    // feed 信息不要求强依赖
  } finally {
    feedLoading.value = false
  }

  // 启动 PouchDB 同步
  pouch.syncFeed(feedId)

  // 等待同步完成
  await new Promise(resolve => setTimeout(resolve, 1000))

  // 从本地 PouchDB 查询该订阅源的条目
  entries.value = await pouch.queryEntries([feedId], 50)
  loading.value = false
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="feed?.title || '订阅源'">
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
          <UButton
            v-else
            icon="i-lucide-bell-off"
            variant="ghost"
            color="error"
            size="sm"
            @click="unsubscribeOpen = true"
          >
            取消订阅
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="feed" class="mb-6">
        <p class="text-sm text-muted">{{ feed.description }}</p>
        <UButton
          v-if="feed.siteUrl"
          :to="feed.siteUrl"
          target="_blank"
          variant="ghost"
          size="sm"
          icon="i-lucide-external-link"
          class="mt-2"
        >
          访问网站
        </UButton>
      </div>

      <div v-if="!entries.length && !loading" class="flex flex-col items-center py-12 gap-4">
        <UIcon name="i-lucide-file-text" class="size-12 text-muted" />
        <p class="text-muted">暂无条目</p>
      </div>

      <EntryList
        v-else
        :entries="entries || []"
        :base-path="`/rss/feed/${feedId}`"
      />

      <!-- 取消订阅确认弹窗 -->
      <UModal
        v-model:open="unsubscribeOpen"
        title="取消订阅"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <p class="text-sm">
            确定要取消订阅
            <span class="font-semibold">{{ feed?.title ?? '该订阅源' }}</span>
            吗？本地已缓存的条目仍可阅读。
          </p>
        </template>

        <template #footer="{ close }">
          <UButton
            variant="outline"
            color="neutral"
            @click="close"
          >
            取消
          </UButton>
          <UButton
            color="error"
            :loading="unsubscribing"
            @click="unsubscribe"
          >
            取消订阅
          </UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
