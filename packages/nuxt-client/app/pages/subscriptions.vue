<script setup lang="ts">
import SubscriptionManager from '~/components/settings/SubscriptionManager.vue'
import { useSettingsModal } from '~/composables/useSettingsModal'

definePageMeta({
  layout: 'default'
})

/**
 * 订阅管理页。
 *
 * 从原「我的 → 订阅管理」标签页搬出来独立成页：订阅列表长、整理时还要来回开编辑弹窗，
 * 比设置弹窗里的一个小分区合适得多。内容组件本身不变（SubscriptionManager 自带
 * 搜索 / 状态筛选 / 分组 / 导入导出），这里只是给它一个整页的空间与标题栏。
 */
const { open: openSettings } = useSettingsModal()
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="订阅管理">
        <template #right>
          <UButton
            icon="i-lucide-settings"
            color="neutral"
            variant="ghost"
            size="sm"
            label="设置"
            @click="openSettings()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl px-4 py-6">
        <SubscriptionManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
