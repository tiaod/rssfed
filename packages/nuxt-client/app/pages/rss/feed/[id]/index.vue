<script setup lang="ts">
import type { RssFeed } from '~/types/rss'
import type { EditableSubscription } from '~/components/settings/EditSubscriptionModal.vue'
import EditSubscriptionModal from '~/components/settings/EditSubscriptionModal.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import ListActionsBar from '~/components/ListActionsBar.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'

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

// 页头（描述 + 访问网站）只在有内容时渲染
const hasFeedHeader = computed(() => Boolean(feed.value?.description || feed.value?.siteUrl))

// 条目数据与同步刷新策略：同步只把新数据拉到本地并累计成「已同步 N 条」提示，一个字都不动
// 列表；用户点「查看」才重新查一次本地库、整体换成最新并回到顶部（见 useSyncedEntryList）。
const {
  entries, newCount, hasMore, listAnchorRef, load, grow, refreshFromSync, applyNew,
  applyNewIfSyncAddedNothing
} = useSyncedEntryList({
  query: limit => pouch.queryFeedEntries(feedId, limit),
  syncedDocs: () => pouch.syncedDocsByFeed[feedId] ?? 0
})

/**
 * 「已同步 N 条」提示条是浮层：盖在列表顶部、不占布局高度，展开不会推动正在读的内容。
 * 代价是它会挡住最上面一条内容，所以按滚动方向让位（见 useEntriesBannerVisibility）。
 */
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef)

// 列表视图：订阅源默认 -> 所属分组默认 -> 全局默认；切换按钮只改本次会话，不落盘
const { view, overridden, setView, resetView, refreshPrefs } = useFeedView(feedId)

// 「全部标记为已读」：只标当前已加载的这批（见 useMarkAllRead）
const markAllRead = useMarkAllRead(entries)

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(() => grow())
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

/**
 * 编辑订阅：弹窗只用到名字 / 分类 / 默认视图，所以从本地订阅文档拼一个最小集，
 * 不必等接口把注册表那份完整对象拿回来（离线也能改）。
 */
const editingItem = ref<EditableSubscription | null>(null)

async function openEdit() {
  const prefs = await pouch.getSubscriptionViewPrefs(feedId).catch(() => null)
  editingItem.value = {
    feedId,
    title: feedDisplayName.value,
    category: prefs?.category ?? undefined,
    view: prefs?.view ?? undefined
  }
}

/** 保存后名字与默认视图都可能变了：就地重读，不用刷新页面 */
async function onEdited() {
  editingItem.value = null
  subscriptionTitle.value = await pouch.getSubscriptionTitle(feedId).catch(() => null) ?? ''
  await refreshPrefs()
}

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
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar :title="feedDisplayName || '订阅源'">
        <template #right>
          <ListViewSwitcher
            :view="view"
            :overridden="overridden"
            @update:view="setView"
            @reset="resetView"
          />
          <ListActionsBar
            :feed-ids="[feedId]"
            sync-label="刷新订阅"
            :feed-id="feedId"
            :has-entries="entries.length > 0"
            @synced="applyNewIfSyncAddedNothing"
            @mark-all-read="markAllRead"
            @edit="openEdit"
            @unsubscribe="openUnsubscribe"
          />
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
      <!--
        定位/滚动锚点容器始终渲染，提示条挂在它下面而不是列表分支里：
        列表为空时同步带来第一批条目，用户必须能看到「已同步 N 条」并点「查看」，
        否则页面会一直停在「暂无条目」（entries 只在 load() 里更新）。
      -->
      <div
        ref="listAnchorRef"
        class="relative flex h-full min-h-0 flex-col"
      >
        <!--
          提示条盖在滚动区顶部（浮层，不占布局），滚动方向由页面控制显隐；
          水平内边距在组件里自带，与滚动区的 px-4 sm:px-6 对齐。
        -->
        <NewEntriesBanner
          floating
          :count="newCount"
          :visible="bannerVisible"
          @apply="applyNew"
        />

        <template v-if="!entries.length && !loading">
          <!-- 空列表：没有可滚动的内容，页头固定在空态上方 -->
          <FeedHeader
            v-if="feed"
            :feed="feed"
            class="mb-2 px-4 sm:px-6"
          />

          <div class="flex flex-col items-center py-12 gap-4">
            <UIcon
              name="i-lucide-file-text"
              class="size-12 text-muted"
            />
            <p class="text-muted">
              暂无条目
            </p>
          </div>
        </template>

        <template v-else>
          <EntryList
            class="min-h-0 flex-1"
            :view="view"
            :entries="entries || []"
            :load-more="loadMore"
            :has-more="hasMoreGetter"
            :header="hasFeedHeader"
          >
            <!-- 页头作为列表首项：跟条目一起滚走，读长列表时不再固定占住视图 -->
            <template
              v-if="hasFeedHeader && feed"
              #header
            >
              <FeedHeader
                :feed="feed"
                class="pb-2"
              />
            </template>
          </EntryList>
        </template>
      </div>

      <!-- 编辑订阅（名字 / 分类 / 默认视图） -->
      <EditSubscriptionModal
        :subscription="editingItem"
        @close="editingItem = null"
        @saved="onEdited"
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
