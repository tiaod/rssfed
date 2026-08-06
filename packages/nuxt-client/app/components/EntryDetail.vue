<script setup lang="ts">
import type { RssEntry } from '~/types/rss'

defineProps<{
  entry: RssEntry
}>()

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <article class="prose prose-neutral dark:prose-invert max-w-none">
    <header>
      <h1 class="text-2xl font-bold mb-2">
        {{ entry.title }}
      </h1>
      <div class="flex flex-wrap items-center gap-3 text-sm text-muted mb-6">
        <span v-if="entry.author">{{ entry.author }}</span>
        <span v-if="entry.feed?.title">&middot; {{ entry.feed.title }}</span>
        <span>&middot; {{ formatDate(entry.publishedAt) }}</span>
        <span v-if="entry.readingTime">&middot; {{ entry.readingTime }} 分钟阅读</span>
      </div>
    </header>

    <div
      class="entry-content"
      v-html="entry.content"
    />

    <footer
      v-if="entry.enclosures?.length"
      class="mt-8 border-t border-default pt-4"
    >
      <h3 class="text-sm font-medium mb-2">
        附件
      </h3>
      <ul class="space-y-1">
        <li
          v-for="(enc, idx) in entry.enclosures"
          :key="idx"
        >
          <UButton
            :to="enc.url"
            target="_blank"
            variant="ghost"
            size="xs"
            :label="enc.url.split('/').pop() || '附件'"
            icon="i-lucide-paperclip"
          />
        </li>
      </ul>
    </footer>

  </article>
</template>
