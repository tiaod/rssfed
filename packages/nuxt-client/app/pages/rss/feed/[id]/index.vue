<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string

const api = useApi()
const pouch = usePouchDb()
const toast = useToast()
const feed = ref<any>(null)
const entries = ref<any[]>([])
const loading = ref(true)
const feedLoading = ref(true)

// ── 无限滚动：查询窗口逐步增大，同步刷新时保留当前深度 ──
const PAGE_SIZE = 50
const MAX_ENTRIES = 10000 // 与集中库 find 上限一致，达到后不再加载
const displayLimit = ref(PAGE_SIZE)

// 滚动到底部附近时加载下一批
const { sentinelRef, loading: loadingMore, hasMore } = useInfiniteList(async () => {
  if (!hasMore.value) return false
  displayLimit.value += PAGE_SIZE
  await refreshEntries()
  return hasMore.value
})

// 从集中库查询该订阅源的条目
async function refreshEntries() {
  entries.value = await pouch.queryFeedEntries(feedId, displayLimit.value)
  // 返回条数达到窗口上限说明可能还有更多；触顶（达到 find 上限）则停止
  hasMore.value = entries.value.length >= displayLimit.value && displayLimit.value < MAX_ENTRIES
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

  // 不自动同步：数据来自集中库（时间线页已增量同步），需要最新时点导航栏同步按钮
  await refreshEntries()
  loading.value = false
})

// 手动同步（syncNow）完成或有新数据时重新查询
watch(
  () => pouch.syncStatuses[feedId]?.version ?? 0,
  () => refreshEntries()
)

// 取消订阅
const unsubscribeOpen = ref(false)
const unsubscribing = ref(false)

function openUnsubscribe() {
  unsubscribeOpen.value = true
}

async function unsubscribe() {
  unsubscribing.value = true
  try {
    await pouch.removeSubscription(feedId)
    toast.add({ title: '已取消订阅', color: 'success' })
    await navigateTo('/')
  } catch (e: any) {
    toast.add({ title: '取消订阅失败', description: e?.message ?? '未知错误', color: 'error' })
  } finally {
    unsubscribing.value = false
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="feed?.title || '订阅源'">
        <template #right>
          <SyncButton :feed-ids="[feedId]" />
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
            @click="openUnsubscribe"
          >
            取消订阅
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="feed"
        class="mb-6"
      >
        <p class="text-sm text-muted">
          {{ feed.description }}
        </p>
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

      <div
        v-if="!entries.length && !loading"
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
        <EntryList
          :entries="entries || []"
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
