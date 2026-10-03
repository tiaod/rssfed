<script setup lang="ts">
import type { RssFeed } from '~/types/rss'
import type { EditableSubscription } from '~/components/settings/EditSubscriptionModal.vue'
import EditSubscriptionModal from '~/components/settings/EditSubscriptionModal.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import ListActionsBar from '~/components/ListActionsBar.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'
import { toEntryDocId, toEntryUrlId } from '~/utils/entryUrlId'

definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string

const api = useApi()
const pouch = usePouchDb()
const toast = useToast()
const feed = ref<RssFeed | null>(null)
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

// 首屏：本地有缓存就先上屏（同步在后台跑，新条目折叠进「已同步 N 条」），
// 没缓存才等优先同步把内容拉回来再上屏 —— 见 useListFirstPaint
const { loading, renderFirstPaint } = useListFirstPaint({
  load,
  hasEntries: () => entries.value.length > 0,
  sync: () => pouch.syncPriority([feedId])
})

// 列表视图：订阅源默认 -> 所属分组默认 -> 全局默认；切换按钮只改本次会话，不落盘
const { view, overridden, setView, resetView, refreshPrefs } = useFeedView(feedId)

// 「只看未读」：不再过滤已加载的窗口，而是按游标深扫未读 —— 扫描只合已读态、不做 enrich，
// 凑够一屏才 enrich 上屏（见 useUnreadFilter）。「全部标记为已读」作用在可见的那批上。
const {
  unreadOnly, visibleEntries, visibleHasMore, loadMoreVisible, toggleUnreadOnly, probing, scannedCount
} = useUnreadFilter({
  entries,
  hasMore: () => hasMore.value,
  grow: () => grow(),
  scan: (cursor, limit) => pouch.scanFeedPage(feedId, cursor, limit),
  enrich: list => pouch.enrichEntries(list)
})
const markAllRead = useMarkAllRead(visibleEntries)

/**
 * 「已同步 N 条」提示条是浮层：盖在列表顶部、不占布局高度，展开不会推动正在读的内容。
 * 代价是它会挡住最上面一条内容，所以按滚动方向让位（见 useEntriesBannerVisibility）。
 * 「只看未读」下整条收起：切进未读就是一次完整刷新（不受列表快照约束），待查看的条目此刻已经
 * 上屏，再顶一条提示就是重复；计数不清零，切回全部时照旧出现。
 */
const { visible: bannerVisible } = useEntriesBannerVisibility(newCount, listAnchorRef, { suppressed: unreadOnly })

// 滚动到底部附近时加载下一批；loadMore 同时供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(loadMoreVisible)

/**
 * 地址 ↔ 详情：条目详情的地址是 `/rss/feed/:id/entry/:entryId`（见 useEntryRoute）。
 *
 * 打开详情仍旧不切页面 —— 详情由布局里的弹窗 / 常驻阅读栏承载，列表原地不动；这里只把
 * 「在读哪一篇」写进地址，于是刷新、分享、浏览器返回键都能落到同一篇上。
 *
 * 地址段里的 id 是文档 id 去掉源前缀后的那截 hash（`entry:<feedId>:<hash12>` → `<hash12>`）：
 * 源已经写在地址里，再重复一遍只是噪音；取文档时按同一规则拼回去（见 utils/entryUrlId）。
 */
const { entryLink, attachListContext } = useEntryRoute({
  listPath: () => `/rss/feed/${feedId}`,
  entryPath: urlId => `/rss/feed/${feedId}/entry/${encodeURIComponent(urlId)}`,
  urlIdOf: entry => toEntryUrlId(entry.id, feedId),
  entries: () => visibleEntries.value,
  loadMore,
  hasMore: visibleHasMore,
  getEntry: urlId => pouch.getEntry(toEntryDocId(urlId, feedId)),
  // 地址里的源与条目要对得上：/rss/feed/1/entry/9（9 属于别的源）按「找不到」处理
  belongs: entry => entry.feedId === feedId
})

/** 用户点「查看」把攒下的新条目上屏后，当前在读的那篇可能才第一次进列表 —— 顺手把翻篇上下文补上 */
async function applyNewEntries() {
  await applyNew()
  attachListContext()
}

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

  // 先上屏、再优先同步这个源：有缓存时一个请求都不等，新条目折叠进「已同步 N 条」提示条
  // （见 useListFirstPaint）；没缓存时才等它跑完（最多 5s）再渲染。
  await renderFirstPaint()
  // 深链进来时详情先按 id 取了全文（列表还没加载完，没有上/下篇可翻）：列表就绪后补挂上下文
  attachListContext()
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
          <!-- 页面状态排在动作之前（切换视图按钮的左边） -->
          <UButton
            v-if="loading"
            loading
            variant="ghost"
            color="neutral"
            size="sm"
          >
            加载中…
          </UButton>

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
            :entry-count="visibleEntries.length"
            :unread-only="unreadOnly"
            @toggle-unread-only="toggleUnreadOnly"
            @synced="applyNewIfSyncAddedNothing"
            @mark-all-read="markAllRead"
            @edit="openEdit"
            @unsubscribe="openUnsubscribe"
          />
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
          @apply="applyNewEntries"
        />

        <template v-if="!visibleEntries.length && !loading">
          <!-- 空列表：没有可滚动的内容，页头固定在空态上方 -->
          <FeedHeader
            v-if="feed"
            :feed="feed"
            class="mb-2 px-4 sm:px-6"
          />

          <!-- 「只看未读」的空态：扫描中 / 扫完这批没找到 / 真的没有，三种情况分开说 -->
          <NoUnreadState
            v-if="unreadOnly"
            :probing="probing"
            :scanned="scannedCount"
            :has-more="visibleHasMore()"
            @scan-more="loadMoreVisible"
            @show-all="toggleUnreadOnly"
          />

          <div
            v-else
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
        </template>

        <template v-else>
          <EntryList
            class="min-h-0 flex-1"
            :view="view"
            :entries="visibleEntries"
            :load-more="loadMore"
            :has-more="visibleHasMore"
            :entry-link="entryLink"
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

      <!--
        `/rss/feed/:id/entry/:entryId` 的落地组件（entry/[entryId].vue，只占位不渲染 DOM）。
        列表页因此是这条地址的父级路由：地址加上那一截时本页不重建，滚动位置与列表快照原地保留。
        详情仍在布局里的弹窗 / 阅读栏，由 useEntryRoute 按这里的路由参数开关。

        父子关系由**文件布局**决定：本页是 `[id].vue`（同名文件 + 同名目录），Nuxt 只认这种写法 ——
        写成 `[id]/index.vue` 时 `[id]/entry/[entryId].vue` 会变成平级路由，一进详情地址
        整个列表页就从 RouterView 里消失，只剩一个空面板。
      -->
      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
