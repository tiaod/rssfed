<script setup lang="ts">
definePageMeta({
  title: '主页 - RSSFed'
})

interface MinifluxFeed {
  id: number
  title: string
  site_url: string
  feed_url: string
  checked_at: string
}

// 调用Miniflux代理API获取订阅列表（只在客户端发起请求，带上认证Cookie）
const { data: feeds, error } = await useFetch<MinifluxFeed[]>('/api/miniflux/feeds', {
  server: false
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="订阅源">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <UContainer>
        <ClientOnly>
          <div
            v-if="error"
            class="py-8 text-center text-red-500"
          >
            <p>加载失败: {{ error.statusMessage || error.message }}</p>
            <p
              v-if="error.statusCode === 401"
              class="mt-2"
            >
              请先登录账号
            </p>
          </div>

          <div
            v-else-if="feeds && feeds.length"
            class="space-y-4 py-4"
          >
            <UCard
              v-for="feed in feeds"
              :key="feed.id"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <UIcon
                      name="i-lucide-rss"
                      class="size-5 text-primary"
                    />
                  </div>
                  <div>
                    <h3 class="font-medium">
                      {{ feed.title }}
                    </h3>
                    <p class="text-sm text-muted">
                      {{ feed.site_url }}
                    </p>
                    <p class="text-xs text-gray-400">
                      最后检查: {{ new Date(feed.checked_at).toLocaleString('zh-CN') }}
                    </p>
                  </div>
                </div>
              </div>
            </UCard>
          </div>

          <UEmpty
            v-else
            icon="i-lucide-rss"
            title="暂无订阅"
            description="在 Miniflux 中添加订阅源后，这里将显示更新"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
