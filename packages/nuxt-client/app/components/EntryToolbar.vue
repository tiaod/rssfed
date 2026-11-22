<script setup lang="ts">
/**
 * 详情面的动作簇：已读 / 未读、收藏、阅读原文、分享。
 *
 * 抽出来是因为弹窗顶栏与宽屏阅读栏顶栏摆的是同一组按钮 —— 图标、配色、快捷键提示都得一致，
 * 两处各写一份，改一个图标就要改两个地方，迟早走样。
 *
 * 只管按钮本身：放在哪、和谁挨着由调用方决定（弹窗要给右侧的关闭按钮让位，阅读栏要接在标题后面）。
 * 快捷键不在这里注册 —— 这个组件在两个展示面里都是常驻的，自己监听键盘会在详情关掉之后
 * 继续作用到上一篇上（closeEntry 只置 isOpen，currentEntry 还留着），见各自的 onKeydown。
 */
import type { RssEntry } from '~/types/rss'
import { useEntryActions } from '~/composables/useEntryActions'
import { useEntryShare } from '~/composables/useEntryShare'
import { ENTRY_SHORTCUT_HINTS } from '~/utils/entryShortcuts'

const props = withDefaults(defineProps<{
  /** 当前正在读的条目；为空时按钮置灰（阅读栏的空态），阅读原文与分享不渲染 */
  entry?: RssEntry | null
  /** 阅读栏顶栏挤，用 xs；弹窗顶栏松一些，用 sm */
  size?: 'xs' | 'sm'
}>(), {
  entry: null,
  size: 'sm'
})

const { readBusy, savedBusy, toggleRead, toggleStar } = useEntryActions(() => props.entry)
const { shareBusy, share } = useEntryShare(() => props.entry)
</script>

<template>
  <div class="flex items-center gap-1">
    <!--
      已读 / 未读：图标与配色直接沿用列表页「只看未读」那个开关（ListActionsBar）——
      已读 = 空心圈、未读 = 圈内实心点 + 主色软底。全站的已读态记号只此一套（列表里的圆点、
      这里的按钮、弹窗工具栏的按钮），别再各写各的。
    -->
    <UButton
      :icon="entry?.read ? 'i-lucide-circle' : 'i-lucide-circle-dot'"
      :color="entry?.read ? 'neutral' : 'primary'"
      :variant="entry?.read ? 'ghost' : 'soft'"
      :aria-label="entry?.read ? '标为未读' : '标为已读'"
      :title="`${entry?.read ? '标为未读' : '标为已读'}（${ENTRY_SHORTCUT_HINTS.toggleRead}）`"
      :loading="readBusy"
      :disabled="!entry"
      :size="size"
      @click="toggleRead"
    />
    <UButton
      icon="i-lucide-star"
      :color="entry?.starred ? 'warning' : 'neutral'"
      :variant="entry?.starred ? 'soft' : 'ghost'"
      :aria-label="entry?.starred ? '取消收藏' : '收藏'"
      :aria-pressed="entry?.starred === true"
      :title="`${entry?.starred ? '取消收藏' : '收藏'}（${ENTRY_SHORTCUT_HINTS.toggleStar}）`"
      :loading="savedBusy"
      :disabled="!entry"
      :size="size"
      @click="toggleStar"
    />
    <!--
      标题本身就是原文链接（见 EntryDetail），这里留一个不用回头找标题的入口。
      url 为空的老条目（RSS 条目没有 <link>，服务端落成 ""）不渲染：to="" 会被解析成当前页，
      点一下等于把正在读的这篇重新加载一遍，与 EntryDetail 里退回纯文本是同一口径。
    -->
    <UButton
      v-if="entry?.url"
      :to="entry.url"
      target="_blank"
      icon="i-lucide-external-link"
      variant="ghost"
      color="neutral"
      :size="size"
      aria-label="阅读原文"
      :title="`阅读原文（${ENTRY_SHORTCUT_HINTS.openOriginal}）`"
    />
    <!-- 分享：系统分享面板（Web Share API），桌面端退回复制「标题 + 原文链接」 -->
    <UButton
      v-if="entry"
      icon="i-lucide-share-2"
      variant="ghost"
      color="neutral"
      :size="size"
      aria-label="分享文章"
      title="分享文章"
      :loading="shareBusy"
      @click="share"
    />
  </div>
</template>
