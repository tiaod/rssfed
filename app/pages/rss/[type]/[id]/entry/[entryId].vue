<script setup lang="ts">
definePageMeta({
  title: '文章 - RSSFed',
  validate: (route) => {
    const type = route.params.type
    return typeof type === 'string' && ['feed', 'category'].includes(type)
  }
})

const route = useRoute()
const type = route.params.type as 'feed' | 'category'
const id = route.params.id as string
const entryId = Number(route.params.entryId)

const open = ref(true)
const api = useApi()
const { isOffline } = useOffline()
const cache = useCacheEntries()

const { data: entry, error } = await useAsyncData('entry', async () => {
  try {
    const result = await api.miniflux.getEntry(entryId)
    cache.saveEntry(result)
    return result
  } catch {
    const cached = await cache.getEntry(entryId)
    if (!cached) throw new Error('该文章未缓存，需要网络连接才能阅读')
    return cached
  }
})

watch(open, (newVal) => {
  if (!newVal) {
    navigateTo(`/rss/${type}/${id}`, { replace: true })
  }
})
</script>

<template>
  <USlideover
    v-model:open="open"
    size="xl"
    title="文章详情"
  >
    <template #body>
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
          <p
            v-else
            class="mt-2 text-sm text-muted"
          >
            {{ isOffline ? '该文章未缓存，需要网络连接才能阅读' : '请检查网络连接后重试' }}
          </p>
        </div>

        <div
          v-else-if="entry"
          class="pb-8"
        >
          <div
            v-if="isOffline"
            class="mb-4"
          >
            <UBadge
              color="warning"
              variant="soft"
              size="sm"
            >
              离线模式 - 显示缓存内容
            </UBadge>
          </div>
          <EntryDetail :entry="entry" />
        </div>

        <UEmpty
          v-else
          icon="i-lucide-file-text"
          title="文章不存在"
          description="找不到该文章"
          class="py-8"
        />
      </ClientOnly>
    </template>
  </USlideover>
</template>
