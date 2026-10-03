<script setup lang="ts">
/**
 * 列表视图条目：紧凑单行，一屏尽可能多的条目。
 *
 * 高度写死（h-24）：列表视图的看点就是密度与整齐，高度浮动会让虚拟化的 item 高度估算
 * 失去意义；摘要固定两行，超出截断。缩略图缺失时不占位——文字块自然铺满整行。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryByline, entryDate, entryExcerpt } from '~/utils/entryDisplay'

const props = defineProps<{
  entry: RssEntry
  showFeed?: boolean
  /** 详情正在展示这条（宽屏阅读栏）：整行加底色，读了右边那篇也知道它对应左边哪行 */
  selected?: boolean
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

const excerpt = computed(() => entryExcerpt(props.entry, 120))
// 聚合视图署源名、单源页署名作者：与卡片视图同规则（口径在 entryByline），
// 只是这里用纯文本（UUser 头像 32px 太占地方）
const byline = computed(() => entryByline(props.entry, props.showFeed))
const date = computed(() => entryDate(props.entry))
</script>

<template>
  <!-- 固定高度放在 article 上（行高一致是列表视图的前提）；点击区用真正的 button，键盘也能打开 -->
  <article
    :data-entry-id="entry.id"
    class="h-24 min-w-0 border-b border-default/60 transition-colors"
    :class="{ 'opacity-60': entry.read, 'bg-primary/10': selected }"
  >
    <button
      type="button"
      class="flex size-full min-w-0 cursor-pointer items-center gap-3 text-left transition-colors hover:bg-elevated/40 focus-visible:bg-elevated/40 focus-visible:outline-none"
      @click="emit('open', entry)"
    >
      <div
        v-if="entry.coverUrl"
        class="size-16 shrink-0 overflow-hidden rounded-md bg-elevated"
      >
        <img
          :src="entry.coverUrl"
          :alt="entry.title"
          loading="lazy"
          decoding="async"
          class="size-full object-cover"
        >
      </div>

      <div class="min-w-0 flex-1">
        <h3 class="line-clamp-1 text-sm font-medium text-highlighted">
          {{ entry.title }}
        </h3>
        <p
          v-if="excerpt"
          class="mt-0.5 line-clamp-2 text-xs text-muted"
        >
          {{ excerpt }}
        </p>
        <p class="mt-1 flex items-center gap-1.5 text-[11px] text-dimmed">
          <span
            v-if="!entry.read"
            class="size-1.5 shrink-0 rounded-full bg-primary"
            data-unread="true"
          >
            <span class="sr-only">未读</span>
          </span>
          <span class="truncate">{{ byline }}</span>
          <template v-if="date">
            <span aria-hidden="true">·</span>
            <time :datetime="entry.publishedAt">{{ date }}</time>
          </template>
        </p>
      </div>
    </button>
  </article>
</template>
