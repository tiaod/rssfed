<script setup lang="ts">
import type { Entry } from '~/lib/miniflux/types'

definePageMeta({
  title: '列表 - RSSFed',
  // 只允许 type 是 feed 或 category，否则返回 404
  validate: (route) => {
    const type = route.params.type
    return typeof type === 'string' && ['feed', 'category'].includes(type)
  }
})

const route = useRoute()
const type = route.params.type as 'feed' | 'category'
const id = route.params.id as string

// 根据类型获取页面标题
const info = ref<{ title: string } | null>(null)

if (type === 'feed') {
  // feed 需要单独请求获取标题
  const { data } = await useFetch<{ title: string }>(
    `/api/miniflux/feeds/${id}`,
    { server: false }
  )
  info.value = data.value ?? null
} else {
  // category 从 /api/miniflux/categories 列表中找标题
  const { data } = await useFetch<Array<{ id: number, title: string }>>(
    '/api/miniflux/categories',
    { server: false }
  )
  info.value = data.value?.find(c => c.id === Number(id)) ?? null
}

// 获取文章列表 API 路径
const apiUrl = computed(() => {
  return `/api/miniflux/${type === 'feed' ? 'feeds' : 'categories'}/${id}/entries`
})

const { data, error } = await useFetch<{ total: number, entries: Entry[] }>(
  apiUrl,
  {
    server: false,
    query: {
      limit: 50,
      order: 'published_at',
      direction: 'desc'
    }
  }
)

const basePath = `/rss/${type}/${id}`
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="info?.title || (type === 'feed' ? '订阅源' : '分类')">
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
            v-else-if="data?.entries?.length"
            class="py-6"
          >
            <EntryList
              :entries="data.entries"
              :base-path="basePath"
            />

            <div
              v-if="data.total > data.entries.length"
              class="mt-6 text-center text-sm text-muted"
            >
              显示 {{ data.entries.length }} / {{ data.total }} 篇文章
            </div>
          </div>

          <UEmpty
            v-else
            icon="i-lucide-newspaper"
            title="暂无文章"
            :description="type === 'feed' ? '该订阅源暂无文章' : '该分类暂无文章'"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>

      <!-- 子路由出口 /rss/:type/:id/entry/:entryId 在这里渲染 -->
      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
