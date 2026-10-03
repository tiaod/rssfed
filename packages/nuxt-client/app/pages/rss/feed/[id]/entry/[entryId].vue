<script setup lang="ts">
/**
 * `/rss/feed/:id/entry/:entryId` 的落地组件。
 *
 * 它只为让这条地址存在：条目详情仍由全局的 EntryDetailModal（窄屏 / 非列表视图）与
 * EntryReaderPane（宽屏列表视图）承载，开关与上/下篇由父级列表页按路由参数驱动
 * （见 useEntryRoute）。
 *
 * 详情不在这里渲染，是为了让父级列表页原地保留：地址加一段不会重建列表，滚动位置、
 * 列表快照、PouchDB 订阅上下文都不丢 —— 这也是本项目一直用弹窗承载详情的原因
 * （见 useEntryModal 的说明），这里只是把地址补上，不是把详情改回独立页面。
 *
 * 版式不在这里声明（不写 definePageMeta）：route.meta 是父子合并的，父级列表页声明的
 * layout 自然继承下来，两边各写一份反而会在将来改动时打架。
 */
</script>

<template>
  <!-- 占位：页面侧不渲染任何 DOM（详情在布局里），不留元素影响列表的布局与滚动 -->
  <div v-if="false" />
</template>
