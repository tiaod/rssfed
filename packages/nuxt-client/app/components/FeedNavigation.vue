<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type { SubscriptionItem } from '~/types/rss'

defineProps<{
  collapsed?: boolean
}>()

const api = useApi()
const toast = useToast()
const pouch = usePouchDb()
const feeds = ref<SubscriptionItem[] | null>(null)
const error = ref<string | null>(null)

// ── 添加订阅 ──
const addOpen = ref(false)
const feedUrl = ref('')
const submitting = ref(false)
const addError = ref<string | null>(null)

// feed 图标（本地缓存 blob 优先），侧边栏菜单项 avatar 用
const iconSrcs = ref<Record<string, string>>({})

/** 从本地用户状态库重新加载订阅列表与各源图标（可被初始挂载与同步后刷新复用） */
async function loadFeeds() {
  try {
    feeds.value = await pouch.listSubscriptions()
    // 异步解析各源图标：附件 blob 优先，回退原始 URL；无图标保持纯文字
    const map: Record<string, string> = {}
    await Promise.all(feeds.value.map(async (f) => {
      const url = await pouch.getFeedImageUrl(f.id)
      if (url) map[f.id] = url
    }))
    iconSrcs.value = map
    error.value = null
  } catch (e: unknown) {
    error.value = errorMessage(e, '加载订阅失败')
  }
}

onMounted(() => {
  void loadFeeds()
})

// 用户状态库（订阅列表）同步版本递增时重新加载侧边栏。
// syncNow 会先暂停用户状态库的 live 同步、一次性复制后恢复，期间拉取的远端订阅
// 变化（新增/改名/分类）不会实时推给侧边栏，这里在同步完成后重新读取订阅列表。
// 防抖：恢复 live 同步会再次触发版本变化，合并为一次刷新。
let feedsTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => pouch.syncStatuses['__user_state__']?.version ?? 0,
  () => {
    if (feedsTimer) clearTimeout(feedsTimer)
    feedsTimer = setTimeout(() => {
      feedsTimer = null
      void loadFeeds()
    }, 200)
  }
)

const { menuItems, hasFeeds } = useFeedNavigation(computed(() => feeds.value), computed(() => iconSrcs.value))

async function addFeed() {
  const url = feedUrl.value.trim()
  if (!url || submitting.value) return
  submitting.value = true
  addError.value = null
  try {
    // 1. 后端解析并注册该订阅源，写入 per-feed 库并触发首轮抓取
    const { feedId, title } = await api.feeds.discover(url)
    // 源没给标题时退回 URL，避免订阅列表里出现空标题
    const feedTitle = title ?? url
    // 2. 在本地 PouchDB 写入订阅关系（自动同步到远端，出现在侧边栏）
    await pouch.addSubscription(feedId, { title: feedTitle })
    toast.add({ title: '订阅成功', description: feedTitle, color: 'success' })
    addOpen.value = false
    feedUrl.value = ''
    feeds.value = await pouch.listSubscriptions()
  } catch (e: unknown) {
    addError.value = errorMessage(e, '订阅失败')
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
          <UFormField
            label="RSS URL"
            required
          >
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
