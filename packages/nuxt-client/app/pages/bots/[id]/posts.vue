<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const botId = route.params.id as string
const virtualFeedId = `bot:${botId}`

const pouch = usePouchDb()
const toast = useToast()
const bot = ref<{ id: string, name: string, description?: string, avatarUrl?: string } | null>(null)
const entries = ref<any[]>([])
const loading = ref(true)
const subscribed = ref(false)

// ── 分页加载：查询窗口逐步增大（不用 useInfiniteScroll，避免 SSR 兼容问题）──
const PAGE_SIZE = 50
const MAX_ENTRIES = 10000 // 与集中库 find 上限一致，达到后不再加载
const displayLimit = ref(PAGE_SIZE)
const loadingMore = ref(false)
const hasMore = ref(true)

// 从集中库查询该 bot 的产出（bot 产出以虚拟 feedId `bot:{id}` 入库）
async function refreshEntries() {
  entries.value = await pouch.queryFeedEntries(virtualFeedId, displayLimit.value)
  // 返回条数达到窗口上限说明可能还有更多；触顶（达到 find 上限）则停止
  hasMore.value = entries.value.length >= displayLimit.value && displayLimit.value < MAX_ENTRIES
  loadingMore.value = false
}

function loadMore() {
  loadingMore.value = true
  displayLimit.value += PAGE_SIZE
  void refreshEntries()
}

onMounted(async () => {
  try {
    // bot 元信息：本地订阅列表优先（离线可用）；回退广场页 query 参数与本地 FeedDoc 头像
    const subs = await pouch.listSubscriptions()
    const sub = subs.find(s => s.id === virtualFeedId)
    subscribed.value = !!sub
    if (sub) {
      bot.value = { id: botId, name: sub.title, description: sub.description, avatarUrl: sub.image }
    } else {
      const name = (route.query.name as string) ?? `Bot ${botId.slice(0, 8)}`
      const icon = await pouch.getFeedImageUrl(virtualFeedId)
      bot.value = { id: botId, name, avatarUrl: icon ?? undefined }
    }
  } catch {
    // bot 信息不要求强依赖
  }
  await refreshEntries()
  loading.value = false
})

// 手动同步（syncNow）完成或有新数据时重新查询
watch(
  () => pouch.syncStatuses[virtualFeedId]?.version ?? 0,
  () => refreshEntries()
)

async function toggleSubscribe() {
  try {
    if (subscribed.value) {
      await pouch.removeSubscription(virtualFeedId)
      toast.add({ title: '已取消订阅', color: 'success' })
    } else {
      await pouch.addBotSubscription(botId, {
        title: bot.value?.name ?? '',
        description: bot.value?.description,
        image: bot.value?.avatarUrl,
      })
      // 订阅后立即触发产出库复制
      pouch.syncFeed(virtualFeedId)
      toast.add({ title: '订阅成功', color: 'success' })
    }
    subscribed.value = !subscribed.value
  } catch (e: any) {
    toast.add({ title: '操作失败', description: e?.message ?? '未知错误', color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="bot?.name || 'Bot 产出'">
        <template #right>
          <SyncButton :feed-ids="[virtualFeedId]" />
          <UButton
            size="sm"
            :color="subscribed ? 'neutral' : 'primary'"
            :variant="subscribed ? 'outline' : 'solid'"
            :icon="subscribed ? 'i-lucide-bell-off' : 'i-lucide-bell-plus'"
            @click="toggleSubscribe"
          >
            {{ subscribed ? '已订阅' : '订阅' }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="bot"
        class="mb-6 flex items-start gap-3"
      >
        <UAvatar
          v-if="bot.avatarUrl"
          :src="bot.avatarUrl"
          :alt="bot.name"
          size="md"
        />
        <div class="min-w-0">
          <p class="text-sm font-semibold">
            {{ bot.name }}
          </p>
          <p
            v-if="bot.description"
            class="text-sm text-muted"
          >
            {{ bot.description }}
          </p>
        </div>
      </div>

      <div
        v-if="!entries.length && !loading"
        class="flex flex-col items-center py-12 gap-4"
      >
        <UIcon
          name="i-lucide-bot"
          class="size-12 text-muted"
        />
        <p class="text-muted">
          暂无产出
        </p>
      </div>

      <template v-else>
        <EntryList
          :entries="entries || []"
        />

        <!-- 分页加载：滚动到底部附近或点击按钮加载下一批 -->
        <div
          v-if="loadingMore"
          class="flex justify-center py-6"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-5 animate-spin text-muted"
          />
        </div>
        <div
          v-else-if="hasMore"
          class="flex justify-center py-4"
        >
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-lucide-chevrons-down"
            @click="loadMore"
          >
            加载更多
          </UButton>
        </div>
        <p
          v-else
          class="py-6 text-center text-xs text-muted"
        >
          已加载全部产出
        </p>
      </template>
    </template>
  </UDashboardPanel>
</template>
