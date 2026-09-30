<script setup lang="ts">
import type { RssFeed } from '~/types/rss'

/**
 * 单源页页头：订阅源描述 + 「访问网站」入口。
 *
 * 抽成组件是因为它有两处用法：列表为空时固定在空态上方；有条目时交给 EntryList 的
 * #header 插槽，作为虚拟列表的首项随列表一起滚动（见 EntryList 的 header prop）。
 */
defineProps<{
  feed: Pick<RssFeed, 'description' | 'siteUrl'>
}>()
</script>

<template>
  <div>
    <p
      v-if="feed.description"
      class="text-sm text-muted"
    >
      {{ feed.description }}
    </p>
    <UButton
      v-if="feed.siteUrl"
      :to="feed.siteUrl"
      target="_blank"
      variant="ghost"
      size="sm"
      icon="i-lucide-external-link"
      class="mt-2"
    >
      访问网站
    </UButton>
  </div>
</template>
