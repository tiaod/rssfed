<script setup lang="ts">
import { ref } from 'vue'
import VueEasyLightbox from 'vue-easy-lightbox/external-css'
import type { RssEntry } from '~/types/rss'
import { useEntryContent } from '~/composables/useEntryContent'
import { useImageLightbox } from '~/composables/useImageLightbox'
import { useSafeHtml } from '~/composables/useSafeHtml'

const props = defineProps<{
  entry: RssEntry
}>()

// 订阅源正文是任意 HTML，注入前必须过白名单：剥掉 <script>/on* 事件/javascript: 协议，
// 并给外链补 target=_blank + rel=noopener（见 useSafeHtml）
const safeContent = useSafeHtml(() => props.entry.content)

// 图片点击放大：滚轮/双指/双击缩放、拖拽平移、旋转、多图切换（见 useImageLightbox）。
// 挂在 useEntryContent 管线的最后一步，保证拿到的是已换成本地 blob URL 的最终地址。
const contentEl = ref<HTMLElement>()
const {
  visible: lightboxVisible,
  index: lightboxIndex,
  images: lightboxImages,
  attach: attachLightbox,
  detach: detachLightbox
} = useImageLightbox(contentEl)

// 将已缓存为 AVIF 附件的正文图片替换为本地 blob URL 直接展示（离线可用，失败回退原 URL），
// 同一管线里还负责代码高亮，见 useEntryContent
useEntryContent(() => props.entry, contentEl, {
  onReady: attachLightbox,
  onTeardown: detachLightbox
})

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
  <article class="prose entry-prose max-w-none dark:prose-invert">
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

    <!--
      正文只在客户端渲染，这是刻意为之，不是可选项：
      服务端没有 DOM，DOMPurify 无法工作（Node 下它是工厂函数，调用会抛 TypeError）。
      如果让 SSR 先输出一个空 div、客户端再填内容，Vue 在 hydration 时不会 patch
      v-html 的 innerHTML（属于被忽略的 prop），正文会**永久空白** —— 实测踩到过。
      ClientOnly 让服务端根本不生成这个节点，从根上避免两端不一致。
    -->
    <!-- eslint-disable vue/no-v-html -- safeContent 已由 useSafeHtml（DOMPurify 白名单）净化，不是未处理的订阅源原文 -->
    <ClientOnly>
      <div
        ref="contentEl"
        class="entry-content"
        v-html="safeContent"
      />
    </ClientOnly>
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

    <!--
      图片放大。teleport 到 body：正文/弹窗所在的容器可能带 transform 或 overflow，
      会把 position:fixed 的遮罩限制在里面，放大后图片被裁切。
      它自身的 z-index（9998）高于 UModal，所以能盖住条目弹窗。
      esc-disabled：ESC 由 useImageLightbox 在 capture 阶段统一接管，
      否则 UModal 会收到同一个 ESC、把条目弹窗一起关掉。
    -->
    <VueEasyLightbox
      :visible="lightboxVisible"
      :imgs="lightboxImages"
      :index="lightboxIndex"
      esc-disabled
      teleport="body"
      @hide="lightboxVisible = false"
    />
  </article>
</template>
