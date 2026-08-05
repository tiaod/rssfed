<script setup lang="ts">
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'

definePageMeta({
  layout: 'default'
})

const userStore = useUserStore()
const user = userStore.user
const { isOnline } = useOffline()

const tabs = [
  { label: '订阅管理', icon: 'i-lucide-rss' },
  { label: '通用', icon: 'i-lucide-settings' }
]
const activeTab = ref(0)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="设置" />
    </template>

    <template #body>
      <div class="max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
        <UTabs
          v-model="activeTab"
          :items="tabs"
        >
          <template #content="{ index }">
            <!-- 订阅管理 -->
            <div
              v-if="index === 0"
              class="pt-4"
            >
              <SubscriptionManager />
            </div>

            <!-- 通用 -->
            <div
              v-else
              class="max-w-md mx-auto pt-4"
            >
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
                      <h2 class="text-lg font-bold">
                        {{ user?.name || '用户' }}
                      </h2>
                      <p class="text-sm text-muted">
                        {{ user?.email }}
                      </p>
                    </div>
                  </div>
                </template>

                <div class="space-y-3">
                  <div class="flex items-center gap-2 text-sm">
                    <UIcon
                      name="i-lucide-wifi"
                      class="size-4"
                      :class="isOnline ? 'text-green-500' : 'text-red-500'"
                    />
                    <span>{{ isOnline ? '在线' : '离线' }}</span>
                  </div>
                </div>
              </UCard>
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
