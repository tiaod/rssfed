<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { SubscriptionItem } from '~/composables/useCouchDb'

defineProps<{
  collapsed?: boolean
}>()

const db = useCouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    feeds.value = await db.listSubscriptions()
  } catch (e: any) {
    error.value = e?.message ?? '加载订阅失败'
  }
})

const { menuItems, hasFeeds } = useFeedNavigation(computed(() => feeds.value))
</script>

<template>
  <div class="mt-4 border-t border-default pt-4">
    <ClientOnly>
      <div
        v-if="error"
        class="px-2"
      >
        <p class="text-xs text-red-500">
          {{ error }}
        </p>
      </div>

      <template v-else>
        <UNavigationMenu
          :collapsed="collapsed"
          :items="menuItems"
          orientation="vertical"
          tooltip
          popover
        />

        <div
          v-if="!hasFeeds"
          class="px-2"
        >
          <p class="text-xs text-muted">
            暂无订阅
          </p>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
