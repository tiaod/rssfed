<script setup lang="ts">
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'
import ListActionsBar from '~/components/ListActionsBar.vue'
import EditSubscriptionModal from '~/components/settings/EditSubscriptionModal.vue'
import type { EditableSubscription } from '~/components/settings/EditSubscriptionModal.vue'

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

// 条目数据与同步刷新策略：同步只把新数据拉到本地并累计成「已同步 N 条」提示，一个字都不动
// 列表；用户点「查看」才重新查一次本地库、整体换成最新并回到顶部（见 useSyncedEntryList）。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew,
  applyNewIfSyncAddedNothing
} = useSyncedEntryList({
  // bot 产出以虚拟 feedId `bot:{id}` 入库
  query: limit => pouch.queryFeedEntries(virtualFeedId, limit),
  syncedDocs: () => pouch.syncedDocsByFeed[virtualFeedId] ?? 0
})

// 列表视图：订阅源默认 -> 所属分组默认 -> 全局默认；切换按钮只改本次会话，不落盘
// （bot 产出用虚拟 feedId 入库，订阅文档同样是 subscription:bot:<id>，规则完全一致）
const { view, overridden, setView, resetView, refreshPrefs } = useFeedView(virtualFeedId)

// 「只看未读」：不再过滤已加载的窗口，而是按游标深扫未读 —— 扫描只合已读态、不做 enrich，
// 凑够一屏才 enrich 上屏（见 useUnreadFilter）。「全部标记为已读」作用在可见的那批上。
const {
  unreadOnly, visibleEntries, visibleHasMore, loadMoreVisible, toggleUnreadOnly, probing, scannedCount
} = useUnreadFilter({
  entries,
  hasMore: () => hasMore.value,
  grow: () => grow(),
  scan: (cursor, limit, notAfter) => pouch.scanFeedPage(virtualFeedId, cursor, limit, notAfter),
  enrich: list => pouch.enrichEntries(list)
})
const markAllRead = useMarkAllRead(visibleEntries)

// 提示条是浮层（盖在列表顶部、不占布局），按滚动方向让位——下滑收起、上滑或回顶部露出
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef)

// 分页加载：查询窗口逐步增大；页尾骨架进入视口就加载下一批（与其它列表页一致）
const { loadMore } = useInfiniteList(loadMoreVisible)

/** bot 订阅文档与普通订阅同形，编辑弹窗直接复用（名字 / 分类 / 默认视图） */
const editingItem = ref<EditableSubscription | null>(null)

async function openEdit() {
  const prefs = await pouch.getSubscriptionViewPrefs(virtualFeedId).catch(() => null)
  editingItem.value = {
    feedId: virtualFeedId,
    title: bot.value?.name ?? '',
    category: prefs?.category ?? undefined,
    view: prefs?.view ?? undefined
  }
}

async function onEdited() {
  editingItem.value = null
  const subs = await pouch.listSubscriptions().catch(() => [])
  const sub = subs.find(s => s.id === virtualFeedId)
  if (sub && bot.value) bot.value = { ...bot.value, name: sub.title, description: sub.description, avatarUrl: sub.image }
  await refreshPrefs()
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
  await load()
  loading.value = false
})

// 该虚拟源同步完成时累计「已同步 N 条」；列表不动，等用户点提示条
watch(
  () => pouch.syncStatuses[virtualFeedId]?.version ?? 0,
  () => refreshFromSync()
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
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar :title="bot?.name || 'Bot 产出'">
        <template #right>
          <ListViewSwitcher
            :view="view"
            :overridden="overridden"
            @update:view="setView"
            @reset="resetView"
          />
          <ListActionsBar
            :feed-ids="[virtualFeedId]"
            sync-label="刷新订阅"
            :feed-id="virtualFeedId"
            :subscribed="subscribed"
            :entry-count="visibleEntries.length"
            :unread-only="unreadOnly"
            @toggle-unread-only="toggleUnreadOnly"
            @synced="applyNewIfSyncAddedNothing"
            @mark-all-read="markAllRead"
            @edit="openEdit"
            @subscribe="toggleSubscribe"
            @unsubscribe="toggleSubscribe"
          />
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
        ref="listAnchorRef"
        class="relative flex h-full min-h-0 flex-col"
      >
        <!-- 浮层提示条：盖在滚动区顶部，不占布局，按滚动方向让位 -->
        <NewEntriesBanner
          floating
          :count="newCount"
          :visible="bannerVisible"
          @apply="applyNew"
        />

        <!-- 「只看未读」的空态：扫描中 / 扫完这批没找到 / 真的没有，三种情况分开说 -->
        <NoUnreadState
          v-if="unreadOnly && !visibleEntries.length && !loading"
          :probing="probing"
          :scanned="scannedCount"
          :has-more="visibleHasMore()"
          @scan-more="loadMoreVisible"
          @show-all="toggleUnreadOnly"
        />

        <div
          v-else-if="!visibleEntries.length && !loading"
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

        <!-- listAnchorRef 供用户点「查看」时定位滚动容器并回到顶部 -->
        <!-- 列表交给 ScrollArea 虚拟化，需要确定高度：容器撑满，列表占剩余空间 -->
        <EntryList
          v-else
          class="min-h-0 flex-1"
          :view="view"
          :entries="visibleEntries"
          :load-more="loadMore"
          :has-more="visibleHasMore"
        />
      </div>

      <!-- 编辑订阅（名字 / 分类 / 默认视图）。必须留在 #body 里：
           UDashboardPanel 的默认插槽会整块替换 header+body，放到外面会把导航栏和列表顶掉。 -->
      <EditSubscriptionModal
        :subscription="editingItem"
        @close="editingItem = null"
        @saved="onEdited"
      />
    </template>
  </UDashboardPanel>
</template>
