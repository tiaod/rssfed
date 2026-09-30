<script setup lang="ts">
import type { RssFeed } from '~/types/rss'

definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string

const api = useApi()
const pouch = usePouchDb()
const toast = useToast()
const feed = ref<RssFeed | null>(null)
const loading = ref(true)
const feedLoading = ref(true)

// 顶栏标题优先用用户在订阅列表里设置的名字（本地订阅文档，离线可用）；
// api.feeds.get 返回的是注册表抓来的原始源标题，只作兜底
const subscriptionTitle = ref('')
const feedDisplayName = computed(() => subscriptionTitle.value || feed.value?.title || '')

// 条目数据与同步刷新策略：同步只把新数据拉到本地并累计成「已同步 N 条」提示，一个字都不动
// 列表；用户点「查看」才重新查一次本地库、整体换成最新并回到顶部（见 useSyncedEntryList）。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew
} = useSyncedEntryList({
  query: limit => pouch.queryFeedEntries(feedId, limit),
  syncedDocs: () => pouch.syncedDocsByFeed[feedId] ?? 0
})

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { sentinelRef, loading: loadingMore, loadMore } = useInfiniteList(() => grow())
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

onMounted(async () => {
  // 订阅名先从本地订阅文档取（离线可用，也是侧边栏显示的名字），取不到再回退接口标题
  subscriptionTitle.value = await pouch.getSubscriptionTitle(feedId).catch(() => null) ?? ''

  try {
    // 加载订阅源信息
    feed.value = await api.feeds.get(feedId)
  } catch {
    // feed 信息不要求强依赖
  } finally {
    feedLoading.value = false
  }

  // 不自动同步：数据来自集中库（时间线页已增量同步），需要最新时点导航栏同步按钮
  await load()
  loading.value = false
})

// 该源同步完成时累计「已同步 N 条」；列表不动，等用户点提示条
watch(
  () => pouch.syncStatuses[feedId]?.version ?? 0,
  () => refreshFromSync()
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
  } catch (e: unknown) {
    toast.add({ title: '取消订阅失败', description: errorMessage(e), color: 'error' })
  } finally {
    unsubscribing.value = false
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="feedDisplayName || '订阅源'">
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
        <!-- listAnchorRef 供用户点「查看」时定位滚动容器并回到顶部 -->
        <div ref="listAnchorRef">
          <!-- 常驻挂载：展开 / 收起由组件内部过渡，列表跟着平滑平移 -->
          <NewEntriesBanner
            :count="newCount"
            @apply="applyNew"
          />
          <EntryList
            :entries="entries || []"
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
        </div>
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
            <span class="font-semibold">{{ feedDisplayName || '该订阅源' }}</span>
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
