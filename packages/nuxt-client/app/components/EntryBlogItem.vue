<script setup lang="ts">
/**
 * 博客文章视图条目：杂志式卡片。
 *
 * 与瀑布流（EntryCardItem）的区别是「统一」：标题与摘要各截断固定行数，
 * **多列时**封面压成等高横条、没封面也补一条同样的带、卡片总高写死 —— 三者一起让卡片完全
 * 等高，泳道按「最矮泳道」分派才能排成规整的行。单列时没有行要对齐，一律放开：没有封面的
 * 条目直接省掉那条占位带，卡片高度交回内容。
 *
 * 单列/多列由 `lanes`（EntryList 的实际列数）决定，**不自己写 CSS 断点**：博客视图的边界
 * 由 EntryList 的断点表定（768px），而 `sm:`(640px) 是另一条线，两者不一致时 640~767
 * 这段就会「已是单列却还留着占位带」。
 *
 * 注意它仍然是「一条一格子」交给 EntryList 的泳道虚拟化摆放，不是 UBlogPosts 那种
 * 整块 grid 容器——列宽与间距由虚拟化算，见 EntryList 的 VIEW_LAYOUT。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import EntryAttribution from '~/components/EntryAttribution.vue'
import { entryCoverImage, entryExcerpt } from '~/utils/entryDisplay'

const props = defineProps<{
  entry: RssEntry
  showFeed?: boolean
  /** 当前列数（EntryList 的泳道数）：多列才需要强制等高 */
  lanes?: number
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

/** 是否需要强制等高：多列时为真（单列没有行要对齐，卡片随内容高矮） */
const uniformHeight = computed(() => (props.lanes ?? 1) > 1)

const excerpt = computed(() => entryExcerpt(props.entry))
const image = computed(() => entryCoverImage(props.entry))
const date = computed(() => new Date(props.entry.publishedAt))
</script>

<template>
  <UBlogPost
    :title="entry.title"
    :description="excerpt"
    :date="date"
    :ui="{
      // 高度不写在 header 上，交给插槽里的子元素决定（见下），header 才能在单列时自然塌成 0 高
      header: 'aspect-auto shrink-0',
      title: 'line-clamp-2',
      description: 'line-clamp-2'
    }"
    :class="uniformHeight ? 'h-[22rem] cursor-pointer' : 'cursor-pointer'"
    @click="emit('open', entry)"
  >
    <!--
      UBlogPost 的 #header 是「覆盖」而不是「追加」：给了插槽就不再渲染内置图片，
      所以这里自己渲染封面图。没有封面时：多列补一条同高占位带（为了行对齐），
      单列它 hidden，header 因此塌成 0 高，条目只剩文字。
    -->
    <template #header>
      <img
        v-if="image"
        v-bind="image"
        class="h-36 w-full object-cover object-top"
      >
      <div
        v-else
        class="h-36 w-full items-center justify-center bg-elevated/60"
        :class="uniformHeight ? 'flex' : 'hidden'"
      >
        <UIcon
          name="i-lucide-newspaper"
          class="size-6 text-dimmed"
        />
      </div>
    </template>

    <template #authors>
      <EntryAttribution
        :entry="entry"
        :show-feed="showFeed"
      />
    </template>
  </UBlogPost>
</template>
