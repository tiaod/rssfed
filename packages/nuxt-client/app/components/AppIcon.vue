<script setup lang="ts">
/**
 * 站点方形图标（侧边栏折叠态、主屏幕安装图标）。
 *
 * 与 AppLogo 分开：Logo 多为横版，直接压进 2rem 的方形槽位会缩成一条细线。
 * 后端端点已按「上传的方形图标 → 站点 Logo 裁方 → 内置 RSS 图形」逐级回退，
 * 前端不需要再判断配置。
 *
 * URL 必须带配置版本号：端点本身是 max-age=300 的短缓存，不带版本时换完图标
 * 刷新页面仍会命中旧缓存（出现过一次）。
 */
const { settings } = useSiteSettings()

const iconUrl = computed(() =>
  `/api/site-settings/icon/192.png${settings.value.version ? `?v=${encodeURIComponent(settings.value.version)}` : ''}`
)

/** 端点不可用（离线且无缓存）时回退内置图形，避免侧边栏空一块 */
const failed = ref(false)

// 换图后 URL 变化，这里复位失败标记，否则一次加载失败会一直停在兜底图形上
watch(iconUrl, () => {
  failed.value = false
})
</script>

<template>
  <span class="inline-flex items-center justify-center">
    <img
      v-if="!failed"
      :src="iconUrl"
      alt="站点图标"
      class="size-full object-contain"
      @error="failed = true"
    >
    <!-- 兜底图形与后端内置默认图标同形：圆角方底 + RSS 符号 -->
    <svg
      v-else
      class="size-full"
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        width="512"
        height="512"
        rx="96"
        fill="var(--ui-primary)"
      />
      <g
        stroke="white"
        stroke-width="56"
        stroke-linecap="round"
      >
        <path d="M144 240 A128 128 0 0 1 272 368" />
        <path d="M144 112 A256 256 0 0 1 400 368" />
      </g>
      <circle
        cx="144"
        cy="368"
        r="36"
        fill="white"
      />
    </svg>
  </span>
</template>
