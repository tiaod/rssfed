<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { SubscriptionItem } from '~/composables/useCouchDb'

defineProps<{
  collapsed?: boolean
}>()

const api = useApi()
const toast = useToast()
const db = useCouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const error = ref<string | null>(null)

// ── 添加订阅 ──
const addOpen = ref(false)
const feedUrl = ref('')
const submitting = ref(false)
const addError = ref<string | null>(null)

onMounted(async () => {
  try {
    feeds.value = await db.listSubscriptions()
  } catch (e: any) {
    error.value = e?.message ?? '加载订阅失败'
  }
})

const { menuItems, hasFeeds } = useFeedNavigation(computed(() => feeds.value))

async function addFeed() {
  const url = feedUrl.value.trim()
  if (!url || submitting.value) return
  submitting.value = true
  addError.value = null
  try {
    // 1. 后端解析并注册该订阅源，写入 per-feed 库并触发首轮抓取
    const { feedId, title } = await api.feeds.discover(url)
    // 2. 在用户状态库写入订阅关系（出现在侧边栏）
    await db.addSubscription(feedId)
    toast.add({ title: '订阅成功', description: title, color: 'success' })
    addOpen.value = false
    feedUrl.value = ''
    feeds.value = await db.listSubscriptions()
  } catch (e: any) {
    const err = e as { data?: { error?: string }, message?: string }
    addError.value = err.data?.error ?? err.message ?? '订阅失败'
  } finally {
    submitting.value = false
  }
}
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

        <!-- 添加订阅入口 -->
        <div class="mt-2 px-2">
          <UButton
            color="neutral"
            variant="soft"
            size="xs"
            class="w-full justify-start"
            :class="collapsed ? 'px-0 justify-center' : ''"
            @click="() => { addOpen = true }"
          >
            <UIcon
              name="i-lucide-rss"
              class="size-4 shrink-0"
            />
            <span v-if="!collapsed">添加订阅源</span>
          </UButton>
        </div>
      </template>
    </ClientOnly>

    <!-- 添加订阅弹窗 -->
    <UModal
      v-model:open="addOpen"
      title="添加订阅源"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <p class="text-sm text-muted mb-3">
          输入 RSS / Atom 订阅地址，解析成功后即可阅读其最新条目。
        </p>

        <UForm @submit="addFeed">
          <UFormField label="RSS URL" required>
            <UInput
              v-model="feedUrl"
              type="url"
              placeholder="https://example.com/feed.xml"
              class="w-full"
            />
          </UFormField>
        </UForm>

        <UAlert
          v-if="addError"
          color="error"
          variant="soft"
          :title="addError"
          class="mt-3"
        />
      </template>

      <template #footer="{ close }">
        <UButton
          variant="outline"
          color="neutral"
          @click="close"
        >
          取消
        </UButton>
        <UButton
          color="primary"
          :loading="submitting"
          :disabled="!feedUrl.trim()"
          @click="addFeed"
        >
          订阅
        </UButton>
      </template>
    </UModal>
  </div>
</template>
