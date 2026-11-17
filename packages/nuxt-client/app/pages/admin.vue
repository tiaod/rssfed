<script setup lang="ts">
import AdminFeedManager from '~/components/admin/AdminFeedManager.vue'
import SiteSettingsManager from '~/components/admin/SiteSettingsManager.vue'

definePageMeta({
  layout: 'default',
  middleware: 'admin'
})

/**
 * 管理员设置页（仅管理员可见）。
 *
 * 原先混在「我的」里，与普通用户的阅读偏好挤在同一排标签页：对普通用户它是两条不存在的
 * 标签，对管理员它又是「站点级配置」和「我自己的偏好」混在一处。这里独立成页，
 * 两个子分区（订阅源 / 站点）仍用标签页切换 —— 它们都只服务管理员，不必再拆两页。
 */
const isAdmin = computed(() => useUserStore().isAdmin)

// UTabs 的 tab 值内部为字符串（String(index)），需用字符串初始值才能默认激活第一个 tab
const activeTab = ref('0')

const tabs = [
  { label: '订阅源', icon: 'i-lucide-shield', value: '0' },
  { label: '站点设置', icon: 'i-lucide-palette', value: '1' }
]
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
      <div class="mx-auto w-full max-w-5xl px-4 py-6 space-y-4">
        <UTabs
          v-model="activeTab"
          :items="tabs"
        >
          <template #content="{ index }">
            <div class="pt-4">
              <AdminFeedManager v-if="index === 0" />
              <SiteSettingsManager v-else-if="index === 1" />
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
