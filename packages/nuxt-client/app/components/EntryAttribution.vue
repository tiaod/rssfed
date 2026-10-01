<script setup lang="ts">
/**
 * 列表卡片署名：聚合视图显示「所属订阅源 + 源图标」，单源页显示条目作者。
 *
 * 抽出来是因为瀑布流与博客视图的卡片署名规则完全一致（时间线/分类页要先知道是哪个源发的，
 * 单源页源名已经写在页面标题里、保留作者名更有信息量）。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryFeedName } from '~/utils/entryDisplay'

const props = defineProps<{
  entry: RssEntry
  showFeed?: boolean
}>()

const feedName = computed(() => entryFeedName(props.entry))
</script>

<template>
  <!--
    署名不用 authors 数组：那条路径渲染 UUser，默认头像 32px（比正文还大），
    且 to 存在时主题带 group-hover/user:scale-115 的放大动画。
    这里用插槽自己渲染，图标尺寸和动效都可控。
  -->
  <ULink
    v-if="showFeed"
    :to="entry.feed?.siteUrl"
    class="group/feed flex min-w-0 items-center gap-1.5"
  >
    <!-- 源图标由 enrichEntries 解析（本地缓存的 AVIF blob URL 优先，离线可用）；
         没有图标时 UAvatar 用 text 显示名字首字母，不占额外空间 -->
    <UAvatar
      :src="entry.feed?.image"
      :alt="feedName"
      :text="feedName.trim()[0] ?? 'R'"
      size="3xs"
      class="shrink-0"
    />
    <span class="truncate text-sm text-muted transition-colors group-hover/feed:text-highlighted">
      {{ feedName }}
    </span>
  </ULink>
  <UUser
    v-else
    :name="entry.author || feedName"
    :to="entry.feed?.siteUrl"
  />
</template>
