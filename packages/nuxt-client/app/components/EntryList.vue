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
  if (!entry.content) return ''
  const plainText = entry.content
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plainText.length > 150
    ? plainText.slice(0, 150) + '…'
    : plainText
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
