<script setup lang="ts">
import type { RssEntry } from '~/types/rss'

const props = defineProps<{
  entries: RssEntry[]
  basePath: string
}>()

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

function getEntryTo(entry: RssEntry): string {
  return `${props.basePath}/entry/${entry.id}`
}
</script>

<template>
  <UPageColumns>
    <UBlogPost
      v-for="entry in entries"
      :key="entry.id"
      :title="entry.title"
      :description="getExcerpt(entry)"
      :date="formatDate(entry.publishedAt)"
      :to="getEntryTo(entry)"
      :authors="[{
        name: entry.author || entry.feed?.title || '未知来源',
        to: entry.feed?.siteUrl,
        avatar: entry.feed?.image
          ? { src: entry.feed.image }
          : undefined
      }]"
    />
  </UPageColumns>
</template>
