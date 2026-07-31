<script setup lang="ts">
import { navigateTo, useRouter } from '#app'
definePageMeta({
  layout: 'default'
})

const route = useRoute()
const feedId = route.params.id as string
const entryId = route.params.entryId as string
const router = useRouter()

const pouch = usePouchDb()
const entry = ref<any>(null)
const pending = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    // 确保 feed 已同步
    pouch.syncFeed(feedId)
    await new Promise(resolve => setTimeout(resolve, 500))

    entry.value = await pouch.getEntry(entryId)
    if (!entry.value) {
      error.value = '条目未找到'
    }
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    pending.value = false
  }
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
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
    </template>

    <template #body>
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        title="加载失败"
        :description="error"
      />

      <div v-else-if="pending" class="flex justify-center py-12">
        <ULoading />
      </div>

      <EntryDetail
        v-else-if="entry"
        :entry="entry"
      />
    </template>
  </UDashboardPanel>
</template>
