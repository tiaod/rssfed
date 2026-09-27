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
const loading = ref(true)
const subscribed = ref(false)
const loadingMore = ref(false)

// 条目数据与同步刷新策略：后台同步到的新条目先累计成「N 条新内容」提示，用户点了才上屏，
// 避免把正在读的内容推走（用户主动点同步按钮时则直接上屏，见 isUserDrivenSync）。
const {
  entries, pendingCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyPending
} = useSyncedEntryList({
  // bot 产出以虚拟 feedId `bot:{id}` 入库
  query: limit => pouch.queryFeedEntries(virtualFeedId, limit)
})

// ── 分页加载：查询窗口逐步增大（不用 useInfiniteScroll，避免 SSR 兼容问题）──
let fetchingNext = false // 防重入：弹窗尾部预加载与「加载更多」按钮共用同一入口
async function loadMore() {
  if (fetchingNext || !hasMore.value) return
  fetchingNext = true
  loadingMore.value = true
  try {
    await grow()
  } finally {
    fetchingNext = false
    loadingMore.value = false
  }
}
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

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
  await load()
  loading.value = false
})

// 同步完成 / 手动同步后重新查询；新条目先进提示条，用户主动同步时直接上屏
watch(
  () => pouch.syncStatuses[virtualFeedId]?.version ?? 0,
  () => void refreshFromSync(pouch.isUserDrivenSync())
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
        image: bot.value?.avatarUrl
      })
      // 订阅后立即触发产出库复制
      pouch.syncFeed(virtualFeedId)
      toast.add({ title: '订阅成功', color: 'success' })
    }
    subscribed.value = !subscribed.value
  } catch (e: unknown) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
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
        <!-- listAnchorRef 供应用「N 条新内容」时定位滚动容器并回到顶部 -->
        <div ref="listAnchorRef">
          <NewEntriesBanner
            v-if="pendingCount"
            :count="pendingCount"
            @apply="applyPending"
          />

          <EntryList
            :entries="entries || []"
            :load-more="loadMore"
            :has-more="hasMoreGetter"
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
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
