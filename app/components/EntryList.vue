<script setup lang="ts">
import type { Entry } from '~/lib/miniflux/types'

const props = defineProps<{
  entries: Entry[]
  basePath: string
}>()

function getEntryImage(entry: Entry): string | undefined {
  const imageEnclosure = entry.enclosures?.find(
    e => e.mime_type.startsWith('image/')
  )
  return imageEnclosure?.url
}

function formatDate(dateStr: string): Date {
  return new Date(dateStr)
}

function getExcerpt(entry: Entry): string {
  if (!entry.content) return ''
  const plainText = entry.content
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plainText.length > 150
    ? plainText.slice(0, 150) + '…'
    : plainText
}

// 构造文章详情页链接（模态路由，在当前页面弹出侧边栏）
function getEntryTo(entry: Entry): string {
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
      :date="formatDate(entry.published_at)"
      :image="getEntryImage(entry)"
      :to="getEntryTo(entry)"
      :authors="[{
        name: entry.author || entry.feed?.title || '未知来源',
        to: entry.feed?.site_url,
        avatar: entry.feed?.icon
          ? { src: `/api/miniflux/feeds/${entry.feed.id}/icon` }
          : undefined
      }]"
    />
  </UPageColumns>
</template>
