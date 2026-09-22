<script setup lang="ts">
import { ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { useEntryContent } from '~/composables/useEntryContent'

const props = defineProps<{
  entry: RssEntry
}>()

// 将已缓存为 AVIF 附件的正文图片替换为本地 blob URL 直接展示（离线可用，失败回退原 URL）
const contentEl = ref<HTMLElement>()
useEntryContent(() => props.entry, contentEl)

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

    <!-- eslint-disable vue/no-v-html -- 正文是订阅源提供的富文本，必须按 HTML 注入；未净化是已知风险（事件属性如 <img onerror> 可执行脚本），净化方案待定 -->
    <div
      ref="contentEl"
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
