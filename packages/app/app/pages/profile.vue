<script setup lang="ts">
import { navigateTo } from '#app'
definePageMeta({
  layout: 'default'
})

const userStore = useUserStore()
const user = userStore.user
const { isOnline } = useOffline()
</script>

<template>
  <UDashboardPanel>
    <UDashboardNavbar title="我的" />

    <UDashboardPanelContent>
      <div class="max-w-md mx-auto space-y-6">
        <UCard>
          <template #header>
            <div class="flex items-center gap-4">
              <UAvatar
                v-if="user?.image"
                :src="user.image"
                :alt="user.name"
                size="lg"
              />
              <UAvatar
                v-else
                :text="user?.name?.[0] || 'U'"
                size="lg"
                color="primary"
              />
              <div>
                <h2 class="text-lg font-bold">{{ user?.name || '用户' }}</h2>
                <p class="text-sm text-muted">{{ user?.email }}</p>
              </div>
            </div>
          </template>

          <div class="space-y-3">
            <div class="flex items-center gap-2 text-sm">
              <UIcon name="i-lucide-wifi" class="size-4" :class="isOnline ? 'text-green-500' : 'text-red-500'" />
              <span>{{ isOnline ? '在线' : '离线' }}</span>
            </div>
          </div>

          <template #footer>
            <UButton
              variant="outline"
              color="error"
              block
              @click="userStore.logout(); navigateTo('/login')"
            >
              退出登录
            </UButton>
          </template>
        </UCard>
      </div>
    </UDashboardPanelContent>
  </UDashboardPanel>
</template>
