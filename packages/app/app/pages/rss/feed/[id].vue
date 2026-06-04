<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string

const api = useApi()
const { data: feed } = await useAsyncData(`feed-${feedId}`, () => api.feeds.get(feedId))
const { data: entries, pending } = await useAsyncData(`feed-entries-${feedId}`, () =>
  api.entries.list({ feedId, limit: 50 })
)
</script>

<template>
  <UDashboardPanel>
    <UDashboardNavbar :title="feed?.title || '订阅源'">
      <template #right>
        <UButton
          v-if="pending"
          loading
          variant="ghost"
          color="neutral"
          size="sm"
        >
          加载中…
        </UButton>
      </template>
    </UDashboardNavbar>

    <UDashboardPanelContent>
      <div v-if="feed" class="mb-6">
        <p class="text-sm text-muted">{{ feed.description }}</p>
        <UButton
          v-if="feed.siteUrl"
          :to="feed.siteUrl"
          target="_blank"
          variant="ghost"
          size="sm"
          icon="i-lucide-external-link"
          class="mt-2"
        >
          访问网站
        </UButton>
      </div>

      <div v-if="!entries?.length && !pending" class="flex flex-col items-center py-12 gap-4">
        <UIcon name="i-lucide-file-text" class="size-12 text-muted" />
        <p class="text-muted">暂无条目</p>
      </div>

      <EntryList
        v-else
        :entries="entries || []"
        :base-path="`/rss/feed/${feedId}`"
      />
    </UDashboardPanelContent>
  </UDashboardPanel>
</template>
