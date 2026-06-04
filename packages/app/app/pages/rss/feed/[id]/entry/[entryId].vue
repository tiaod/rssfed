<script setup lang="ts">
import { navigateTo, useRouter } from '#app'
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const entryId = route.params.entryId as string
const router = useRouter()

const api = useApi()
const { data: entry, pending, error } = await useAsyncData(`entry-${entryId}`, () =>
  api.entries.get(entryId)
)
</script>

<template>
  <UDashboardPanel>
    <UDashboardNavbar title="文章详情">
      <template #right>
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-arrow-left"
          @click="router.back()"
        >
          返回
        </UButton>
      </template>
    </UDashboardNavbar>

    <UDashboardPanelContent>
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error.message"
      />

      <div v-else-if="pending" class="flex justify-center py-12">
        <ULoading />
      </div>

      <EntryDetail
        v-else-if="entry"
        :entry="entry"
      />
    </UDashboardPanelContent>
  </UDashboardPanel>
</template>
