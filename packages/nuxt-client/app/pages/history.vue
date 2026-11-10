<script setup lang="ts">
import type { RssEntry } from '~/types/rss'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import HistoryEntryList from '~/components/HistoryEntryList.vue'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空
import EntryListSkeleton from '~/components/EntryListSkeleton.vue'

definePageMeta({
  layout: 'default'
})

const pouch = usePouchDb()

const entries = ref<RssEntry[]>([])
const error = ref<string | null>(null)

/**
 * 分页：queryHistoryEntries 的窗口是按**阅读时间**切的（见 usePouchDb），
 * 加大 limit 就等于往下翻历史，不需要额外的游标。
 */
const PAGE_SIZE = 50
const MAX_ENTRIES = 10000
const displayLimit = ref(PAGE_SIZE)
const hasMore = ref(true)

async function load() {
  try {
    const next = await pouch.queryHistoryEntries(displayLimit.value)
    entries.value = next
    hasMore.value = next.length >= displayLimit.value && displayLimit.value < MAX_ENTRIES
    error.value = null
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载最近阅读失败')
  }
}

/**
 * 首屏节流与骨架延迟借用 `useListFirstPaint`（不传 `sync`：历史页没有优先同步，只查本地库）。
 *
 * 与收藏页同一个口径：`loading` 只表示「本地库第一批查询还没回来」，一结束就是真实内容；
 * 几十毫秒的查询由 `showSkeleton` 挡掉不画骨架。`load()` 自己不碰 `loading` —— 往下翻历史
 * 不该把已经读到的内容换回骨架。
 */
const { loading, showSkeleton, renderFirstPaint } = useListFirstPaint({ load })

/** 返回「是否还可能更多」，与 useInfiniteList 的约定一致（false 时不再触发） */
async function grow(): Promise<boolean> {
  if (!hasMore.value) return false
  displayLimit.value = Math.min(displayLimit.value + PAGE_SIZE, MAX_ENTRIES)
  await load()
  return hasMore.value
}

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore, loading: loadingMore } = useInfiniteList(() => grow())
// 弹窗的列表上下文要的是取值函数：hasMore 是 ref，在模板里会被解包，脚本侧包一层
const hasMoreGetter = () => hasMore.value

const { isOpen, currentEntry, openEntry } = useEntryModal()

/**
 * 历史页用专用视图（按阅读日期分组，见 HistoryEntryList），打开详情的列表上下文仍是
 * 「过滤后的历史」：弹窗里的上一篇/下一篇要沿当前看到的那一段走，而不是穿到已被隐藏的行。
 */
function handleOpen(entry: RssEntry) {
  openEntry(entry, () => visibleEntries.value, { loadMore, hasMore: hasMoreGetter })
}

/**
 * 历史是「读过什么」，所以条目被标为未读时应当当场从历史里消失（列表与详情共用同一个
 * 条目对象，就地改 read 就能生效，不用重查）。
 *
 * 正在弹窗里读的那一条例外：它被标未读后若也消失，「上一篇 / 下一篇」的基准列表就断了，
 * 与「只看未读」保留当前那篇是同一个口径（见 useUnreadFilter）。
 */
const visibleEntries = computed(() => {
  const openId = isOpen.value ? currentEntry.value?.id : undefined
  return entries.value.filter(entry => entry.read !== false || entry.id === openId)
})

onMounted(renderFirstPaint)
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar title="最近阅读">
        <!--
          导航栏右侧不再有「加载中…」转圈按钮：内容区的骨架已经表态，同一件事说两遍只会挤走
          别的位置（历史页右栏本来就是空的，留一个转圈更像误触）。四个带动作区的列表页
          与收藏页也一起统一去掉。
        -->
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error"
        class="mb-4"
      />

      <div class="flex h-full min-h-0 flex-col">
        <template v-if="loading">
          <!--
            首屏骨架：历史页列表本身是列表式版式（按阅读日期的单列时间流，见 HistoryEntryList），
            所以固定传 `view="list"`，高度节奏与真实的紧凑单行一致、替换上去不跳版。
            外层认 `loading`（本地查询还没回来，不能落到空态），里层认 `showSkeleton`
            （几十毫秒就结束的查询连骨架都不画，免得闪一下）。
          -->
          <EntryListSkeleton
            v-if="showSkeleton"
            class="min-h-0 flex-1"
            view="list"
            show-feed
          />
        </template>

        <div
          v-else-if="!visibleEntries.length"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-history"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            还没有阅读记录
          </p>
          <p class="text-xs text-dimmed">
            打开任意条目后会自动记入最近阅读
          </p>
        </div>

        <!-- 历史页专用视图：按阅读日期分组、带日期分割线与具体阅读时刻（见 HistoryEntryList） -->
        <HistoryEntryList
          v-else
          class="min-h-0 flex-1"
          :entries="visibleEntries"
          :load-more="loadMore"
          :loading-more="loadingMore"
          @open="handleOpen"
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
