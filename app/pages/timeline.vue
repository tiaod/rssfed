<script setup lang="ts">
definePageMeta({
  title: '动态 - RSSFed'
})

interface ActivityItem {
  id: string
  type: string
  content: string
  actor: {
    name: string
    avatar: string
    url: string
  }
  published: string
}

const { data: timeline } = await useFetch<ActivityItem[]>('/api/activitypub/timeline')
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
              v-for="item in timeline"
              :key="item.id"
            >
              <div class="flex items-start gap-3">
                <UAvatar
                  :src="item.actor.avatar"
                  :alt="item.actor.name"
                  size="sm"
                />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium">
                      {{ item.actor.name }}
                    </span>
                    <span class="text-sm text-muted">
                      {{ item.type }}
                    </span>
                  </div>
                  <div
                    class="mt-2 text-sm prose prose-sm dark:prose-invert max-w-none"
                  >
                    {{ item.content }}
                  </div>
                </div>
              </div>
            </UCard>
          </div>

          <UEmpty
            v-else
            icon="i-lucide-activity"
            title="暂无动态"
            description="活动推送功能即将上线，敬请期待"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
