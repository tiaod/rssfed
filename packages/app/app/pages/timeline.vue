<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

const api = useApi()
const { data: entries, pending, error } = await useAsyncData('timeline', () => api.entries.list({ limit: 50 }))
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="时间线">
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
    </template>

    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error.message"
      />

      <div v-else-if="pending" class="flex justify-center py-12">
        <ULoading />
      </div>

      <div v-else-if="!entries?.length" class="flex flex-col items-center py-12 gap-4">
        <UIcon name="i-lucide-inbox" class="size-12 text-muted" />
        <p class="text-muted">暂无条目，先订阅一些 RSS 源吧</p>
        <UButton to="/" variant="outline" color="neutral">
          去发现订阅源
        </UButton>
      </div>

      <EntryList
        v-else
        :entries="entries"
        base-path="/rss/feed"
      />
    </template>
  </UDashboardPanel>
</template>
