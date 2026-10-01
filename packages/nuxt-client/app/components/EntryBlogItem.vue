<script setup lang="ts">
/**
 * 博客文章视图条目：等高杂志卡片。
 *
 * 与瀑布流（EntryCardItem）的区别是「统一」——封面固定 16:9（UBlogPost 主题默认值，
 * 这里不再覆盖），标题与摘要各截断固定行数，于是同列卡片高度几乎一致，多列时排成
 * 规整的杂志网格而不是参差的瀑布流。
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
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

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
      // 高度不写在 header 上，交给插槽里的子元素决定（见下）：
      // 多列时封面是等高横条、没有封面的条目补一条同高占位带，卡片总高再固定（sm:h-[22rem]），
      // 三者一起让卡片完全等高 —— 虚拟化按「最矮泳道」放条目，高度不一致就会像瀑布流那样错位。
      // 手机单列没有行要对齐，于是不再强制等高：占位带直接折叠，卡片高度随内容。
      header: 'aspect-auto shrink-0',
      title: 'line-clamp-2',
      description: 'line-clamp-2'
    }"
    class="cursor-pointer sm:h-[22rem]"
    @click="emit('open', entry)"
  >
    <!--
      UBlogPost 的 #header 是「覆盖」而不是「追加」：给了插槽就不再渲染内置图片，
      所以这里自己渲染封面图。没有封面时：sm 以上补一条同高占位带（为了行对齐），
      手机上它 hidden，header 因此自然塌成 0 高，条目只剩文字。
    -->
    <template #header>
      <img
        v-if="image"
        v-bind="image"
        class="h-36 w-full object-cover object-top"
      >
      <div
        v-else
        class="hidden h-36 w-full items-center justify-center bg-elevated/60 sm:flex"
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
