<script setup lang="ts">
definePageMeta({
  title: '动态 - RSSFed'
})

interface MastodonPost {
  id: string
  content: string
  account: {
    username: string
    display_name: string
    avatar: string
    url: string
  }
  favourites_count: number
  reblogs_count: number
}

const { data: timeline } = await useFetch<MastodonPost[]>('/api/mastodon/timeline')
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar
        title="动态"
        :ui="{ right: 'gap-3' }"
      >
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <UContainer>
        <ClientOnly>
          <div
            v-if="timeline && timeline.length"
            class="space-y-4 py-4"
          >
            <UCard
              v-for="post in timeline"
              :key="post.id"
            >
              <div class="flex items-start gap-3">
                <UAvatar
                  :src="post.account.avatar"
                  :alt="post.account.username"
                  size="sm"
                />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">
                      {{ post.account.display_name || post.account.username }}
                    </span>
                    <span class="text-sm text-muted">
                      @{{ post.account.username }}
                    </span>
                  </div>
                  <div
                    class="mt-2 text-sm prose prose-sm dark:prose-invert max-w-none"
                    v-html="post.content"
                  />
                  <div class="mt-3 flex items-center gap-4 text-muted">
                    <span class="flex items-center gap-1">
                      <UIcon
                        name="i-lucide-heart"
                        class="size-4"
                      />
                      {{ post.favourites_count }}
                    </span>
                    <span class="flex items-center gap-1">
                      <UIcon
                        name="i-lucide-repeat"
                        class="size-4"
                      />
                      {{ post.reblogs_count }}
                    </span>
                  </div>
                </div>
              </div>
            </UCard>
          </div>

          <UEmptyState
            v-else
            icon="i-lucide-activity"
            title="暂无动态"
            description="连接 Mastodon 账号后将显示时间线"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
