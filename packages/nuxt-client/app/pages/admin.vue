<script setup lang="ts">
import SiteSettingsManager from '~/components/admin/SiteSettingsManager.vue'

definePageMeta({
  layout: 'default',
  middleware: 'admin'
})

/**
 * 管理员设置页（仅管理员可见）。
 *
 * **只剩站点设置**：「订阅源管理」随共享源库一起删掉了 —— 新模型里没有"全站共享的源"
 * 这种东西，每个用户抓自己的东西，源级操作（改名、分组、暂停、退订）全是订阅级的，
 * 在个人设置里就能做（见 components/settings/SubscriptionManager.vue）。
 */
const isAdmin = computed(() => useUserStore().isAdmin)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="管理后台">
        <template #right>
          <UBadge
            v-if="isAdmin"
            color="primary"
            variant="subtle"
            size="xs"
          >
            <template #leading>
              <UIcon
                name="i-lucide-shield"
                class="size-3"
              />
            </template>
            管理员
          </UBadge>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-5xl px-4 py-6">
        <SiteSettingsManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
