<script setup lang="ts">
/**
 * 社交动态视图条目：像社交媒体那样一条一条的信息流。
 *
 * 与卡片视图（瀑布流 / 博客）的差别在**正文与封面的主次**：信息流的头部是「谁发的、什么时候」，
 * 主体是文字，图片缩到文字下方 —— 而卡片视图是封面占满顶部、文字收在下半区。
 * 版式是四段：作者行（头像 + 署名 + 相对时间 + 未读圆点）/ 正文按钮（标题 + 摘要 + 图片）/
 * 操作栏（已读、收藏、新窗口打开原文）/ 底部分隔线。
 *
 * 图片区按张数换版式：一张按原比例上屏（长图与超宽图夹进 0.7~2.4 之间，只截中间一段），
 * 2~6 张铺成 3 列相册网格、最后一行横向拉满 —— 见 utils/entryDisplay.ts 的 feedImageCell。
 * 图片的本地 blob URL 由 useEntryImages 懒取（列表投影只解好了封面那张）。
 *
 * 内容列固定 `max-w-xl`(576px) 并居中，**分隔线挂在内容列上**（不是整条泳道）：线因此与文字
 * 两端对齐，而不是横贯整个面板。宽度按「以后右侧还要加一栏（AI 摘要 / 趋势 / 推荐订阅）」选的：
 * 1440 下 左栏 240 + 内容 576 + 右栏 ~350 + 间距 还能放得下。手机与桌面都是这一条窄列。
 *
 * 只有正文是打开详情的热区（作者行、操作栏、分隔线都不是），所以热区用真正的 `<button>`：
 * 整条 `@click` 的卡片写法（见 EntryCardItem）在这类「一条里有多块可点内容」的版式上会把
 * 点击目标变得含糊，而且按钮里塞不下操作栏的 `<a>`。
 *
 * 高度随内容变化（单列，没有行要对齐），由 EntryList 的 estimateSize 估算、虚拟化逐条测量纠正。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import {
  entryByline,
  entryDate,
  entryExcerpt,
  entryFeedName,
  entryRelativeTime,
  feedImageCell,
  feedSingleAspect
} from '~/utils/entryDisplay'
// 显式导入：单测环境没有 Nuxt 自动导入，裸调 composable 会直接 ReferenceError
import { useEntryActions } from '~/composables/useEntryActions'
import { useEntryImages } from '~/composables/useEntryImages'

const props = defineProps<{
  entry: RssEntry
  /** 聚合视图（时间线 / 分类页）：作者行显示所属订阅源 */
  showFeed?: boolean
  /** 详情正在展示这条：整条加底色（与其它视图同一口径） */
  selected?: boolean
}>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

const feedName = computed(() => entryFeedName(props.entry))
const byline = computed(() => entryByline(props.entry, props.showFeed))
// 摘要比卡片视图长一档：信息流就是来「读正文首段」的，四行以内还给得动
const excerpt = computed(() => entryExcerpt(props.entry, 220))
/** 相对时间只作观感，精确日期放进 `<time>` 的 title（见 entryRelativeTime） */
const relative = computed(() => entryRelativeTime(props.entry))
const absolute = computed(() => entryDate(props.entry))

/**
 * 图片：本地 blob URL 由 useEntryImages 懒取（列表投影只解好了封面那张）。
 * 一张时按原比例、限高限宽；多张时铺成相册网格。
 */
const { media } = useEntryImages(() => props.entry)
const singleAspect = computed(() => feedSingleAspect(media.value[0]))

/** 相册格子的跨度与比例：3 列（6 列栅格，一格跨 2），最后一行不足 3 张时横向拉满 */
function cellStyle(index: number) {
  const { span, aspect } = feedImageCell(index, media.value.length)
  return {
    gridColumn: `span ${span} / span ${span}`,
    aspectRatio: String(aspect)
  }
}

/**
 * 操作栏的两个动作：写入口径与详情工具栏同一份（见 useEntryActions），这里只是接到本条上。
 * 结果就地写回 `props.entry`（列表数组里的那个对象），列表立刻淡显 / 换圆点，不重查。
 */
const { readBusy, savedBusy, toggleRead, toggleStar } = useEntryActions(() => props.entry)
</script>

<template>
  <article
    :data-entry-id="entry.id"
    class="transition-colors"
    :class="{ 'opacity-60': entry.read, 'bg-primary/10': selected }"
  >
    <div class="mx-auto w-full max-w-xl border-b border-default/60 py-4">
      <!--
        头像占左侧一栏（对齐 X 那种版式），署名 / 正文 / 操作栏整块与**头像右边**对齐 ——
        正文缩进去一点、左边缘统一，扫读时视线不用在头像与文字之间来回跳。
        `items-start`：头像顶端与署名首行齐平（头像比一行字高，居中会让署名看起来往下坠）。
      -->
      <div class="flex items-start gap-2">
        <!-- 头像用源图标（单源页署名换成作者，头像仍是这个源 —— 条目数据里没有作者头像） -->
        <UAvatar
          :src="entry.feed?.image"
          :alt="feedName"
          :text="feedName.trim()[0] ?? 'R'"
          size="md"
          class="shrink-0"
        />

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <header class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium text-highlighted">{{ byline }}</span>
            <span
              v-if="relative"
              class="shrink-0 text-xs text-dimmed"
              :title="absolute"
            >
              <time :datetime="entry.publishedAt">{{ relative }}</time>
            </span>
            <span
              v-if="!entry.read"
              class="size-1.5 shrink-0 rounded-full bg-primary"
              data-unread="true"
            >
              <span class="sr-only">未读</span>
            </span>
          </header>

          <button
            type="button"
            class="flex w-full cursor-pointer flex-col gap-2 text-left"
            @click="emit('open', entry)"
          >
            <h3 class="line-clamp-2 text-[15px] font-semibold leading-snug text-highlighted">
              {{ entry.title }}
            </h3>
            <p
              v-if="excerpt"
              class="line-clamp-4 text-sm leading-relaxed text-muted"
            >
              {{ excerpt }}
            </p>

            <!--
              图片区：一张按原比例（限高限宽，长图/超宽图只截中间一段）；2~6 张铺成相册网格，
              最后一行不足三张时横向拉满（见 feedImageCell）。相册里的图一律裁成格子比例。

              `self-start` 不能省：父级是 flex 纵向容器，默认 align-items:stretch 会把单图撑满整列宽，
              比例就废了（竖图变成一屏宽的横条）。让它自己按「原比例 + max-h/max-w」定尺寸。
            -->
            <img
              v-if="media.length === 1"
              :src="media[0]!.src"
              :alt="entry.title"
              loading="lazy"
              decoding="async"
              :style="{ aspectRatio: String(singleAspect) }"
              class="max-h-[28rem] w-auto max-w-full self-start rounded-xl bg-elevated object-cover ring-1 ring-default"
            >
            <div
              v-else-if="media.length > 1"
              class="grid grid-cols-6 gap-1.5"
            >
              <div
                v-for="(image, index) in media"
                :key="image.src"
                :style="cellStyle(index)"
                class="overflow-hidden rounded-lg bg-elevated ring-1 ring-default"
              >
                <img
                  :src="image.src"
                  :alt="entry.title"
                  loading="lazy"
                  decoding="async"
                  class="size-full object-cover"
                >
              </div>
            </div>
          </button>

          <!--
            操作栏：动作与记号沿用详情工具栏那一套（已读对 circle / circle-dot、星标、原文新窗口），
            只是版式收进信息流。三个动作连排靠左（不再把原文单独甩到右边）：动作栏是一条「补充操作」，
            贴齐正文左边缘更好扫读。`-mx-2.5` 抵消按钮自身主题内边距（sm 尺寸是 px-2.5），图标的
            左边缘才和正文对齐；配色刻意保持中性：信息流里绝大多数条目都未读，若沿用工具栏
            「未读＝主色软底」，整列会挂满高亮按钮变成噪声（状态另有作者行的圆点与整条淡显）。
          -->
          <footer class="-mx-2.5 flex items-center gap-1">
            <UButton
              :icon="entry.read ? 'i-lucide-circle' : 'i-lucide-circle-dot'"
              :aria-label="entry.read ? '标为未读' : '标为已读'"
              :title="entry.read ? '标为未读' : '标为已读'"
              :loading="readBusy"
              variant="ghost"
              color="neutral"
              size="sm"
              @click="toggleRead"
            />
            <UButton
              icon="i-lucide-star"
              :color="entry.starred ? 'warning' : 'neutral'"
              :variant="entry.starred ? 'soft' : 'ghost'"
              :aria-label="entry.starred ? '取消收藏' : '收藏'"
              :aria-pressed="entry.starred === true"
              :title="entry.starred ? '取消收藏' : '收藏'"
              :loading="savedBusy"
              size="sm"
              @click="toggleStar"
            />

            <!-- 原文：真链接（新窗口），不经过详情弹窗 —— 想直接看原文时不必先打开一层 -->
            <UButton
              :to="entry.url"
              target="_blank"
              rel="noopener noreferrer"
              icon="i-lucide-external-link"
              :aria-label="`在新窗口打开原文：${entry.title}`"
              title="在新窗口打开原文"
              variant="ghost"
              color="neutral"
              size="sm"
            />
          </footer>
        </div>
      </div>
    </div>
  </article>
</template>
