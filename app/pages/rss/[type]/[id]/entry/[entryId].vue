<script setup lang="ts">
import type { Entry } from '~/lib/miniflux/types'

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

const { data: entry, error } = await useFetch<Entry>(
  `/api/miniflux/entries/${entryId}`,
  { server: false }
)

// 当 open 变为 false 时（用户点击遮罩/关闭按钮），导航回列表
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
        </div>

        <div
          v-else-if="entry"
          class="pb-8"
        >
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
