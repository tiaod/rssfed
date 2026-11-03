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

// 历史页不属于任何订阅源，视图默认值只取全局那一层；会话内切换同样不落盘（见 useListView）
const { view, overridden, setView, resetView } = useListViewState(
  'history',
  () => settings.value.view ?? DEFAULT_LIST_VIEW
)

const entries = ref<RssEntry[]>([])
const loading = ref(true)
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
    error.value = errorMessage(e, '加载历史失败')
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

const { isOpen, currentEntry } = useEntryModal()

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

onMounted(load)
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar title="历史">
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
            打开任意条目后会自动记入历史
          </p>
        </div>

        <!-- 列表交给 ScrollArea 虚拟化，需要确定高度：容器撑满，列表占剩余空间 -->
        <EntryList
          v-else
          class="min-h-0 flex-1"
          :view="view"
          :entries="visibleEntries"
          :load-more="loadMore"
          :has-more="hasMoreGetter"
          show-feed
        />
      </div>
    </template>
  </UDashboardPanel>
</template>
