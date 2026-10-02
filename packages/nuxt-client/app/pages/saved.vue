<script setup lang="ts">
import type { RssEntry } from '~/types/rss'
// 显式导入：新组件偶尔不在 dev server 已扫描到的组件清单里，隐式解析会静默渲染成空（见 UserMenu 的同类注释）
import ListViewSwitcher from '~/components/ListViewSwitcher.vue'
import { useListViewState } from '~/composables/useListView'
import { DEFAULT_LIST_VIEW } from '~/utils/listViews'

definePageMeta({
  layout: 'default'
})

const pouch = usePouchDb()
const { settings } = useSettings()

// 收藏页不属于任何订阅源，视图默认值只取全局那一层；会话内切换同样不落盘（见 useListView）
const { view, overridden, setView, resetView } = useListViewState(
  'saved',
  () => settings.value.view ?? DEFAULT_LIST_VIEW
)

const entries = ref<RssEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

/**
 * 分页：querySavedEntries 的窗口是按**收藏时间**切的（见 usePouchDb），
 * 加大 limit 就等于往下翻收藏夹，不需要额外的游标。
 */
const PAGE_SIZE = 50
const MAX_ENTRIES = 10000
const displayLimit = ref(PAGE_SIZE)
const hasMore = ref(true)

async function load() {
  try {
    const next = await pouch.querySavedEntries(displayLimit.value)
    entries.value = next
    hasMore.value = next.length >= displayLimit.value && displayLimit.value < MAX_ENTRIES
    error.value = null
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载收藏失败')
  } finally {
    loading.value = false
  }
}

/** 返回「是否还可能更多」，与 useInfiniteList 的约定一致（false 时不再触发） */
async function grow(): Promise<boolean> {
  if (!hasMore.value) return false
  displayLimit.value = Math.min(displayLimit.value + PAGE_SIZE, MAX_ENTRIES)
  await load()
  return hasMore.value
}

// 滚动到底部附近时加载下一批；loadMore 同样供文章弹窗尾部的自动预加载复用（单飞防重入）
const { loadMore } = useInfiniteList(() => grow())
// EntryList 的 hasMore 需要取值函数；hasMore 是 ref，在模板里已被解包，故在脚本侧包一层
const hasMoreGetter = () => hasMore.value

const { isOpen } = useEntryModal()

onMounted(load)

/**
 * 弹窗里取消收藏之后，那一条要从收藏夹里消失。
 *
 * 选择在**关闭弹窗时**重查，而不是在取消收藏的当下：后者会让正在读的这条立刻从
 * 「上一篇 / 下一篇」的基准列表里消失。纯本地查询、窗口几十条，重查很轻；
 * 收藏夹少一条也不需要保留精确滚动位置。
 */
watch(isOpen, (open) => {
  if (!open) void load()
})
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar title="收藏">
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
        class="mb-4"
      />

      <div class="flex h-full min-h-0 flex-col">
        <div
          v-if="loading"
          class="flex justify-center py-12"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-8 animate-spin text-muted"
          />
        </div>

        <div
          v-else-if="!entries.length"
          class="flex flex-col items-center py-12 gap-4"
        >
          <UIcon
            name="i-lucide-star"
            class="size-12 text-muted"
          />
          <p class="text-muted">
            还没有收藏
          </p>
          <p class="text-xs text-dimmed">
            打开任意条目，用底部工具栏的星标收藏
          </p>
        </div>

        <!-- 列表交给 ScrollArea 虚拟化，需要确定高度：容器撑满，列表占剩余空间 -->
        <EntryList
          v-else
          class="min-h-0 flex-1"
          :view="view"
          :entries="entries"
          :load-more="loadMore"
          :has-more="hasMoreGetter"
          show-feed
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
