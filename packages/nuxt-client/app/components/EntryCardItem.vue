<script setup lang="ts">
/**
 * 瀑布流条目卡片（默认视图）：封面按原比例、高度随内容变化。
 *
 * 与博客视图（EntryBlogItem）的差别就在封面比例与摘要行数：这里封面 `aspect-auto` +
 * 高度区间限制，超长图裁底部、超宽横幅裁两侧，卡片高度因此参差，由 EntryList 的
 * 多列虚拟化按「最矮泳道」摆放。
 *
 * 已读态：淡显 + 未读圆点（圆点走 UBlogPost 的 badge 插槽，渲染在日期之前）。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import EntryAttribution from '~/components/EntryAttribution.vue'
import { entryCoverImage, entryExcerpt } from '~/utils/entryDisplay'

const props = defineProps<{
  entry: RssEntry
  /** 聚合视图（时间线 / 分类页）：卡片上显示所属订阅源 */
  showFeed?: boolean
  /** 详情正在展示这条（宽屏阅读栏）：卡片描一圈主题色边框 */
  selected?: boolean
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

const excerpt = computed(() => entryExcerpt(props.entry))
const image = computed(() => entryCoverImage(props.entry))
const date = computed(() => new Date(props.entry.publishedAt))
</script>

<template>
  <!--
    包裹一层：UBlogPost 的根是 Primitive，不透传 data-* 属性（class 是 Vue 的特例），
    而列表外围（验证脚本、测试）要能按条目 id 精确核对已读态；淡显也顺带落在这里。
  -->
  <div
    :data-entry-id="entry.id"
    class="rounded-lg"
    :class="{ 'opacity-60': entry.read, 'ring-2 ring-primary': selected }"
  >
    <UBlogPost
      :title="entry.title"
      :description="excerpt"
      :date="date"
      :image="image"
      :ui="{
        // 封面不统一裁剪比例：按原比例显示，仅限制高度区间——超长的长图裁底部，超宽的横幅裁两侧，避免过长刷屏或过短成一条线
        header: 'aspect-auto',
        // 手机两列时卡片只有 ~170px 宽：封面高度区间、内边距、字号、摘要行数都按窄屏收一档
        // （sm: 以上还原原样），否则一行标题要折四五行，卡片会被文字拉成细高条
        image: 'h-auto min-h-28 max-h-56 object-cover object-top sm:min-h-40 sm:max-h-80',
        body: 'p-3 sm:p-6',
        title: 'text-base sm:text-xl',
        description: 'line-clamp-4 text-sm sm:line-clamp-none sm:text-base',
        date: 'text-xs sm:text-sm',
        authors: 'pt-3 sm:pt-4'
      }"
      class="cursor-pointer"
      @click="emit('open', entry)"
    >
      <!-- 未读圆点：UBlogPost 的 badge 插槽渲染在日期之前，正好当状态标记 -->
      <template #badge>
        <span
          v-if="!entry.read"
          class="size-2 shrink-0 rounded-full bg-primary"
          data-unread="true"
        >
          <span class="sr-only">未读</span>
        </span>
      </template>

      <template #authors>
        <EntryAttribution
          :entry="entry"
          :show-feed="showFeed"
        />
      </template>
    </UBlogPost>
  </div>
</template>
