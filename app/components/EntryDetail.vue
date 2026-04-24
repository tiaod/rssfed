<script setup lang="ts">
import type { Entry } from '~/lib/miniflux/types'

defineProps<{
  entry: Entry
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
        <span>&middot; {{ formatDate(entry.published_at) }}</span>
        <span>&middot; {{ entry.reading_time }} 分钟阅读</span>
      </div>
    </header>

    <!-- eslint-disable vue/no-v-html -->
    <div
      class="entry-content"
      v-html="entry.content"
    />
    <!-- eslint-enable vue/no-v-html -->

    <footer
      v-if="entry.enclosures?.length"
      class="mt-8 border-t border-default pt-4"
    >
      <h3 class="text-sm font-medium mb-2">
        附件
      </h3>
      <ul class="space-y-1">
        <li
          v-for="enc in entry.enclosures"
          :key="enc.id"
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

    <div class="mt-6 flex gap-2">
      <UButton
        :to="entry.url"
        target="_blank"
        label="阅读原文"
        icon="i-lucide-external-link"
        variant="outline"
        size="sm"
      />
    </div>
  </article>
</template>
