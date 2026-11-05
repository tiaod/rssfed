<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryByline } from '~/utils/entryDisplay'
import { groupEntriesByReadDay, readTimeLabel } from '~/utils/historyDateGroup'

/**
 * 历史页专用视图：**按阅读日期分组的时间流**。
 *
 * 不与 EntryList 的通用视图（瀑布流 / 博客 / 紧凑列表 / 图片 / 表格）共用：
 * 那些视图是「按发布时间排列的浏览列表」，历史页要看的是「我什么时候读过什么」，
 * 日期分割线 + 阅读时刻才是它的主线。因此这里固定单列、自己的滚动容器，
 * 也不参与全局列表视图设置（见 pages/history.vue）。
 *
 * 数据量控制由页面负责（分页窗口逐步放大，见 useInfiniteList）：这里不做虚拟化，
 * 一次只渲染已加载的窗口；条目再多也是页面决定何时续拉。
 */
const props = defineProps<{
  entries: RssEntry[]
  /** 加载下一页；底部哨兵进入视口时调用（单飞由页面的 useInfiniteList 保证） */
  loadMore?: () => unknown
  /** 正在加载下一批（底部提示用） */
  loadingMore?: boolean
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

/** 分组按「连续同一天」切刀，输入顺序（阅读时间倒序）原样保留 */
const groups = computed(() => groupEntriesByReadDay(props.entries))

const bylineOf = (entry: RssEntry) => entryByline(entry, true)

/**
 * 触底哨兵：进入视口就请求下一批。
 *
 * 列表没有虚拟化，所以固定放一个高度很小的元素在末尾；它与其它列表页的
 * 「页尾骨架进视口即加载」是同一个信号口径，只是这里不占列。
 */
const sentinel = ref<HTMLElement | null>(null)
useIntersectionObserver(
  sentinel,
  (list) => {
    if (list.some(item => item.isIntersecting)) void props.loadMore?.()
  },
  { rootMargin: '0px 0px 200px 0px' }
)
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto w-full max-w-3xl px-4 pb-8 sm:px-6">
      <section
        v-for="(group, index) in groups"
        :key="`${group.key}-${index}`"
      >
        <!--
          日期分割线：日期标题吸顶（滚动时始终知道当前这一段是哪天），右侧细线贯穿整行。
          负外边距抵消内容块的水平内边距、再用同样的 px 补回：吸顶背景才能盖满滚动容器的
          整宽，两侧不会露出底下滚过的条目（与页面默认的 px-4 sm:px-6 成对）。
        -->
        <header class="sticky top-0 z-10 -mx-4 bg-default px-4 pt-4 pb-2 sm:-mx-6 sm:px-6">
          <div class="flex items-center gap-3">
            <h2 class="shrink-0 text-xs font-medium text-muted">
              {{ group.label }}
            </h2>
            <div class="h-px flex-1 border-t border-default/60" />
          </div>
        </header>

        <article
          v-for="entry in group.entries"
          :key="entry.id"
          class="border-b border-default/60"
        >
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 py-3 text-left transition-colors hover:bg-elevated/40 focus-visible:bg-elevated/40 focus-visible:outline-none"
            @click="emit('open', entry)"
          >
            <div class="min-w-0 flex-1">
              <h3 class="line-clamp-1 text-sm font-medium text-highlighted">
                {{ entry.title }}
              </h3>
              <p class="mt-0.5 line-clamp-1 text-xs text-muted">
                {{ bylineOf(entry) }}
              </p>
            </div>
            <!-- 阅读时刻：日期已由分割线给出，这里只补具体时:分；老条目没有 readAt 就整段省略 -->
            <time
              v-if="readTimeLabel(entry.readAt)"
              :datetime="entry.readAt"
              class="shrink-0 text-xs tabular-nums text-dimmed"
            >{{ readTimeLabel(entry.readAt) }}</time>
          </button>
        </article>
      </section>

      <!-- 触底哨兵：进入视口触发下一批；加载中给一行提示 -->
      <div
        ref="sentinel"
        class="flex justify-center py-6"
        aria-hidden="true"
      >
        <span
          v-if="loadingMore"
          class="text-xs text-dimmed"
        >
          加载中…
        </span>
      </div>
    </div>
  </div>
</template>
