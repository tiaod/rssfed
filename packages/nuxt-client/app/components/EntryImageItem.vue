<script setup lang="ts">
/**
 * 图片视图条目：按封面真实比例的瀑布流图块（不裁切）。
 *
 * 宽度由虚拟化的泳道给（`lanes`），高度由封面宽高比决定 —— 这正是 Nuxt UI 文档里
 * masonry 例子的做法（lanes + 变高图片）；区别是我们按 `images` 里的压缩尺寸算准比例，
 * 而不是给一个常数估算：图片还没加载时首帧布局和总高度就已经是对的。
 *
 * 只突出封面（本地缓存的 AVIF blob）；标题压在底部、悬停或键盘聚焦时才露出，避免图片墙
 * 变回文字墙。拿不到封面 / 比例的条目给一块 4:3 占位块而不是过滤掉 —— 每页条数保持稳定，
 * 触底加载的节奏才不会被「这页只剩 3 条有图」打乱。
 */
import { computed } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryCoverAspect, entryCoverImage, IMAGE_TILE_FALLBACK_ASPECT } from '~/utils/entryDisplay'

const props = defineProps<{ entry: RssEntry }>()

const emit = defineEmits<{ open: [entry: RssEntry] }>()

const image = computed(() => entryCoverImage(props.entry))

/** 图块宽高比：有封面按真实比例，没有则 4:3（与 EntryList 的高度估算共用同一口径） */
const aspect = computed(() => entryCoverAspect(props.entry) ?? IMAGE_TILE_FALLBACK_ASPECT)
</script>

<template>
  <button
    type="button"
    :style="{ aspectRatio: String(aspect) }"
    class="group relative block w-full cursor-pointer overflow-hidden rounded-lg bg-elevated ring-1 ring-default transition-shadow hover:ring-accented focus-visible:ring-2 focus-visible:ring-primary"
    @click="emit('open', entry)"
  >
    <img
      v-if="image"
      :src="image.src"
      :alt="image.alt"
      loading="lazy"
      decoding="async"
      class="size-full object-cover transition-transform duration-300 group-hover:scale-105"
    >

    <!-- 无封面：占位块 + 标题，保证每一格都能看出是哪条 -->
    <span
      v-else
      class="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center"
    >
      <UIcon
        name="i-lucide-image-off"
        class="size-5 text-dimmed"
      />
      <span class="line-clamp-3 text-[11px] leading-tight text-dimmed">{{ entry.title }}</span>
    </span>

    <!-- 有封面时标题压在底部，只在悬停 / 聚焦时出现 -->
    <span
      v-if="image"
      class="absolute inset-x-0 bottom-0 line-clamp-2 bg-default/85 px-2 py-1 text-left text-[11px] leading-tight text-highlighted opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {{ entry.title }}
    </span>
  </button>
</template>
