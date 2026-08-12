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
  <UPageColumns class="gap-4 space-y-4">
    <UBlogPost
      v-for="entry in entries"
      :key="entry.id"
      :title="entry.title"
      :description="getExcerpt(entry)"
      :date="formatDate(entry.publishedAt)"
      :authors="[{
        name: entry.author || entry.feed?.title || '未知来源',
        to: entry.feed?.siteUrl,
        avatar: entry.feed?.image
          ? { src: entry.feed.image }
          : undefined
      }]"
      class="cursor-pointer"
      @click="openEntry(entry)"
    />
  </UPageColumns>
</template>
