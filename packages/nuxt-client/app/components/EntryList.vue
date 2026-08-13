<script setup lang="ts">
import type { RssEntry } from '~/types/rss'

defineProps<{
  entries: RssEntry[]
}>()

const { openEntry } = useEntryModal()

function formatDate(dateStr: string): Date {
  return new Date(dateStr)
}

function getExcerpt(entry: RssEntry): string {
  // 列表查询裁剪了 content（全文）字段，摘要优先用 description（列表查询仍包含）
  const text = (entry.description || entry.content || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 150
    ? text.slice(0, 150) + '…'
    : text
}
</script>

<template>
  <!-- UPageColumns 默认最多 lg:3 列，大屏追加更多列（3xl/4xl 断点在 main.css 定义） -->
  <UPageColumns class="gap-4 space-y-4 xl:columns-4 2xl:columns-5 3xl:columns-6 4xl:columns-8">
    <UBlogPost
      v-for="entry in entries"
      :key="entry.id"
      :title="entry.title"
      :description="getExcerpt(entry)"
      :date="formatDate(entry.publishedAt)"
      :image="entry.coverUrl
        ? { src: entry.coverUrl, alt: entry.title }
        : undefined"
      :ui="{
        // 封面不统一裁剪比例：按原比例显示，仅限制高度区间——超长的长图裁底部，超宽的横幅裁两侧，避免过长刷屏或过短成一条线
        header: 'aspect-auto',
        image: 'h-auto min-h-40 max-h-80 object-cover object-top'
      }"
      :authors="[{
        name: entry.author || entry.feed?.title || '未知来源',
        to: entry.feed?.siteUrl
      }]"
      class="cursor-pointer"
      @click="openEntry(entry)"
    />
  </UPageColumns>
</template>
