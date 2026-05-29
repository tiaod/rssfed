<script setup lang="ts">
import type { Entry } from '~/lib/miniflux/types'

definePageMeta({
  title: '列表 - RSSFed',
  validate: (route) => {
    const type = route.params.type
    return typeof type === 'string' && ['feed', 'category'].includes(type)
  }
})

const route = useRoute()
const type = route.params.type as 'feed' | 'category'
const id = route.params.id as string

const api = useApi()
const { isOffline } = useOffline()
const cache = useCacheEntries()

const info = ref<{ title: string } | null>(null)

if (type === 'feed') {
  const { data } = await useAsyncData('feedInfo', () => api.miniflux.getFeed(Number(id)))
  info.value = data.value ?? null
} else {
  const { data } = await useAsyncData('categories', () => api.miniflux.getCategories())
  info.value = data.value?.find(c => c.id === Number(id)) ?? null
}

const entries = ref<Entry[]>([])
const total = ref(0)

const { error } = await useAsyncData('entries', async () => {
  try {
    const result = await api.miniflux.getEntries(type === 'feed' ? 'feeds' : 'categories', id, {
      limit: 50,
      order: 'published_at',
      direction: 'desc'
    })

    if (result.entries?.length) {
      entries.value = result.entries
      total.value = result.total
      cache.saveEntries(result.entries)
    }
  } catch {
    const cached = await cache.getEntries({ limit: 50, order: 'desc' })
    entries.value = cached.entries
    total.value = cached.total
  }
})

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
            v-if="isOffline"
            class="mt-2"
          >
            <UBadge
              color="warning"
              variant="soft"
              size="sm"
            >
              离线模式 - 显示已缓存的内容，部分信息可能不完整
            </UBadge>
          </div>

          <div
            v-if="error && !entries.length"
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
            v-else-if="entries.length"
            class="py-6"
          >
            <EntryList
              :entries="entries"
              :base-path="basePath"
            />

            <div
              v-if="total > entries.length"
              class="mt-6 text-center text-sm text-muted"
            >
              显示 {{ entries.length }} / {{ total }} 篇文章
            </div>
          </div>

          <UEmpty
            v-else
            icon="i-lucide-newspaper"
            title="暂无文章"
            :description="isOffline ? '暂无离线缓存' : (type === 'feed' ? '该订阅源暂无文章' : '该分类暂无文章')"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>

      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
