<script setup lang="ts">
import { computed } from 'vue'

/**
 * 列表的收尾提示：本地条目到底了。
 *
 * 单源页会传 `siteUrl`：本地的源库只保留该源最近的一段条目（按活跃度留 10~50 条，
 * 见 ARCHITECTURE.md），滚到底**不代表这个源没有更多内容**——再给一条去原网站的路，
 * 用户才知道还能接着去哪儿看。聚合页（时间线 / 分类 / 收藏 / Bot 产出）没有单一的
 * 「原网站」，不传这个 prop，提示就只是「已加载全部条目」。
 *
 * 虚拟化列表的尽头与表格视图的 `#body-bottom` 共用这一份，两处文案与外链口径不会走散。
 */
const props = defineProps<{
  /**
   * 订阅源的站点地址。只接受 http(s)：它来自抓取到的源元信息，不能直接当 href 用
   * （`javascript:` / `data:` 这类地址在这里被丢掉，收尾提示照常显示、只是不给外链）。
   */
  siteUrl?: string
}>()

const externalUrl = computed(() => {
  const raw = props.siteUrl?.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
})
</script>

<template>
  <div class="flex flex-col items-center gap-1.5 py-6 text-center">
    <p class="text-xs text-muted">
      已加载全部条目
    </p>
    <!-- 外链用 UButton 的 link 变体：比正文重一点、又不至于在安静的页尾抢一屏的注意力 -->
    <UButton
      v-if="externalUrl"
      :to="externalUrl"
      target="_blank"
      rel="noopener noreferrer"
      variant="link"
      size="xs"
      trailing-icon="i-lucide-external-link"
      label="去原网站看更多"
    />
  </div>
</template>
