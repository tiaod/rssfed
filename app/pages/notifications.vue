<script setup lang="ts">
definePageMeta({
  title: '消息 - RSSFed'
})

interface AppNotification {
  id: string
  type: 'mention' | 'like' | 'follow' | 'reblog'
  message: string
  read: boolean
  created_at: string
}

const { data: notifications } = await useFetch<AppNotification[]>('/api/notifications')

const iconMap: Record<string, string> = {
  mention: 'i-lucide-at-sign',
  like: 'i-lucide-heart',
  follow: 'i-lucide-user-plus',
  reblog: 'i-lucide-repeat'
}

const colorMap: Record<string, string> = {
  mention: 'text-primary',
  like: 'text-success',
  follow: 'text-info',
  reblog: 'text-warning'
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar
        title="消息"
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
            v-if="notifications && notifications.length"
            class="space-y-4 py-4"
          >
            <UCard
              v-for="notification in notifications"
              :key="notification.id"
              :class="!notification.read ? 'border-primary' : ''"
            >
              <div class="flex items-start gap-3">
                <div
                  class="flex size-10 items-center justify-center rounded-full bg-elevated"
                >
                  <UIcon
                    :name="iconMap[notification.type] || 'i-lucide-bell'"
                    :class="colorMap[notification.type] || ''"
                    class="size-5"
                  />
                </div>
                <div class="flex-1">
                  <p class="text-sm">
                    {{ notification.message }}
                  </p>
                  <p class="text-xs text-muted">
                    {{ new Date(notification.created_at).toLocaleString() }}
                  </p>
                </div>
                <UBadge
                  v-if="!notification.read"
                  color="primary"
                  variant="solid"
                  size="xs"
                >
                  新
                </UBadge>
              </div>
            </UCard>
          </div>

          <UEmpty
            v-else
            icon="i-lucide-bell"
            title="暂无消息"
            description="暂无新的通知或私信"
            class="py-8"
          />
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
