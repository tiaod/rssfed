<script setup lang="ts">
/**
 * 设置弹窗里的一组行：小标题 + 一张卡片，卡片内各行用分隔线相连。
 *
 * 分组而不是把所有行排成一长列：设置项按主题（阅读 / 同步 / 数据）聚成块后，
 * 用户扫的是「我要调哪一类」而不是逐行读说明；分隔线只在行之间画，
 * 卡片边框已经把整组圈成一个整体，把外框再切开反而碎。
 */
defineProps<{
  label: string
}>()
</script>

<template>
  <section class="space-y-2">
    <h3 class="px-1 text-xs font-medium text-muted">
      {{ label }}
    </h3>
    <div class="divide-y divide-default overflow-hidden rounded-xl border border-default bg-default">
      <slot />
    </div>
  </section>
</template>
