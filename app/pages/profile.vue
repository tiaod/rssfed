<script setup lang="ts">
definePageMeta({
  title: '我的 - RSSFed'
})

interface User {
  name: string
  email: string
  avatar: string
}

const { data: user } = await useFetch<User>('/api/user')

const menuItems = [
  {
    label: '个人资料',
    icon: 'i-lucide-user',
    to: '/profile/edit'
  },
  {
    label: '订阅源管理',
    icon: 'i-lucide-rss',
    to: '/profile/feeds'
  },
  {
    label: '主题设置',
    icon: 'i-lucide-palette',
    to: '/profile/theme'
  }
]
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar
        title="我的"
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
          <div class="py-4">
            <div class="mb-6 flex items-center gap-4">
              <UAvatar
                v-if="user"
                :src="user.avatar"
                :alt="user.name"
                size="lg"
              />
              <UAvatar
                v-else
                size="lg"
              />
              <div>
                <h2 class="text-lg font-semibold">
                  {{ user?.name || '用户' }}
                </h2>
                <p class="text-sm text-muted">
                  {{ user?.email }}
                </p>
              </div>
            </div>

            <div class="space-y-2">
              <NuxtLink
                v-for="item in menuItems"
                :key="item.to"
                :to="item.to"
                class="flex items-center gap-3 rounded-lg p-3 hover:bg-elevated transition-colors"
              >
                <UIcon
                  :name="item.icon"
                  class="size-5 text-muted"
                />
                <span class="font-medium">
                  {{ item.label }}
                </span>
                <UIcon
                  name="i-lucide-chevron-right"
                  class="ml-auto size-4 text-muted"
                />
              </NuxtLink>
            </div>

            <div class="mt-6">
              <UButton
                variant="ghost"
                color="error"
                block
                icon="i-lucide-log-out"
              >
                退出登录
              </UButton>
            </div>
          </div>
        </ClientOnly>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>
