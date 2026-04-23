<script setup lang="ts">
import type { Feed } from '~/lib/miniflux/types'

defineProps<{
  collapsed?: boolean
}>()

const { data: feeds, error } = await useFetch<Feed[]>('/api/miniflux/feeds', {
  server: false
})

const { menuItems, hasFeeds } = useFeedNavigation(computed(() => feeds.value ?? null))
</script>

<template>
  <div class="mt-4 border-t border-default pt-4">
    <ClientOnly>
      <div
        v-if="error"
        class="px-2"
      >
        <p class="text-xs text-red-500">
          加载失败
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
