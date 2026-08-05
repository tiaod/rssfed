<script setup lang="ts">
import type { FeedSubscriptionItem, FeedStatus } from '~/types/rss'
import SubscriptionItem from '~/components/settings/SubscriptionItem.vue'
import EditSubscriptionModal from '~/components/settings/EditSubscriptionModal.vue'

const api = useApi()
const toast = useToast()
const pouch = usePouchDb()

const subscriptions = ref<FeedSubscriptionItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// ── 筛选 / 搜索 ──
const statusFilter = ref<'all' | FeedStatus>('all')
const keyword = ref('')

// ── 分组视图 ──
const grouped = ref(true)
const collapsedGroups = ref<Set<string>>(new Set())

function toggleGroup(name: string) {
  if (collapsedGroups.value.has(name)) {
    collapsedGroups.value.delete(name)
  } else {
    collapsedGroups.value.add(name)
  }
}

// ── 取消订阅确认 ──
const pendingRemove = ref<FeedSubscriptionItem | null>(null)
const confirming = ref(false)
const confirmError = ref<string | null>(null)

// ── 编辑弹窗 ──
const editingItem = ref<FeedSubscriptionItem | null>(null)

const confirmOpen = computed({
  get: () => pendingRemove.value !== null,
  set: (v: boolean) => { if (!v) pendingRemove.value = null }
})

const statusFilters = computed(() => {
  const counts = { all: subscriptions.value.length, active: 0, paused: 0, error: 0 }
  for (const s of subscriptions.value) counts[s.status]++
  return [
    { label: '全部', value: 'all', badge: counts.all },
    { label: '活跃', value: 'active', badge: counts.active },
    { label: '已暂停', value: 'paused', badge: counts.paused },
    { label: '错误', value: 'error', badge: counts.error }
  ]
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return subscriptions.value.filter((s) => {
    if (statusFilter.value !== 'all' && s.status !== statusFilter.value) return false
    if (!kw) return true
    return s.title.toLowerCase().includes(kw) || (s.siteUrl ?? '').toLowerCase().includes(kw)
  })
})

/** 按分类分组，未分类单独一组排在最后 */
const groupedFiltered = computed(() => {
  const map = new Map<string, FeedSubscriptionItem[]>()
  for (const sub of filtered.value) {
    const cat = sub.category?.trim() || '未分类'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(sub)
  }
  // 未分类排最后
  const groups = [...map.entries()].sort((a, b) => {
    if (a[0] === '未分类') return 1
    if (b[0] === '未分类') return -1
    return a[0].localeCompare(b[0], 'zh-CN')
  })
  return groups.map(([name, items]) => ({ name, items }))
})

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

async function load() {
  loading.value = true
  error.value = null
  try {
    // 1. 从本地 PouchDB 读取订阅（离线可用）
    const localSubs = await pouch.listSubscriptions()

    // 2. 在线时从服务端获取抓取状态（active/paused/error），合并到本地数据
    let statusMap = new Map<string, { status: FeedStatus, errorMessage?: string, lastFetchedAt?: string }>()
    try {
      const remote = await api.feeds.subscriptions()
      for (const r of remote) {
        statusMap.set(r.feedId, {
          status: r.status,
          errorMessage: r.errorMessage,
          lastFetchedAt: r.lastFetchedAt,
        })
      }
    } catch {
      // 离线时忽略，状态使用默认值
    }

    // 3. 合并：本地订阅数据 + 服务端抓取状态（只读）
    subscriptions.value = localSubs.map(sub => {
      const st = statusMap.get(sub.id)
      return {
        feedId: sub.id,
        title: sub.title,
        siteUrl: sub.siteUrl,
        image: sub.image,
        description: sub.description,
        category: sub.category,
        createdAt: sub.createdAt,
        status: st?.status ?? 'active',
        errorMessage: st?.errorMessage,
        lastFetchedAt: st?.lastFetchedAt,
      } as FeedSubscriptionItem
    })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

/** 确认取消订阅 */
async function confirmRemove() {
  if (!pendingRemove.value) return
  confirming.value = true
  confirmError.value = null
  try {
    await pouch.removeSubscription(pendingRemove.value.feedId)
    toast.add({ title: '已取消订阅', description: pendingRemove.value.title, color: 'success' })
    pendingRemove.value = null
    await load()
  } catch (e) {
    confirmError.value = errorMessage(e)
  } finally {
    confirming.value = false
  }
}

function onEdited() {
  editingItem.value = null
  load()
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <!-- 加载失败 -->
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      title="加载失败"
      icon="i-lucide-circle-alert"
    >
      <template #description>
        {{ error }}
      </template>
      <template #actions>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          @click="load"
        >
          重试
        </UButton>
      </template>
    </UAlert>

    <template v-else>
      <!-- 工具栏：状态筛选 + 搜索 + 分组切换 -->
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-2">
          <UTabs
            v-model="statusFilter"
            :items="statusFilters"
            :content="false"
            size="sm"
          />
          <UButton
            :icon="grouped ? 'i-lucide-folder-tree' : 'i-lucide-list'"
            :color="grouped ? 'primary' : 'neutral'"
            :variant="grouped ? 'soft' : 'ghost'"
            size="xs"
            :aria-label="grouped ? '分组视图' : '平铺视图'"
            @click="grouped = !grouped"
          />
        </div>
        <UInput
          v-model="keyword"
          icon="i-lucide-search"
          placeholder="搜索订阅名称或站点…"
          class="w-full sm:w-72"
          clearable
        />
      </div>

      <!-- 加载中骨架 -->
      <div
        v-if="loading"
        class="space-y-3"
      >
        <USkeleton
          v-for="i in 3"
          :key="i"
          class="h-24 w-full rounded-xl"
        />
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="!filtered.length"
        class="flex flex-col items-center gap-3 py-12 text-muted"
      >
        <UIcon
          :name="subscriptions.length ? 'i-lucide-search-x' : 'i-lucide-rss'"
          class="size-10"
        />
        <p class="text-sm">
          {{ subscriptions.length ? '没有匹配的订阅' : '还没有订阅任何源，在侧边栏添加吧' }}
        </p>
      </div>

      <!-- 分组视图 -->
      <template v-else-if="grouped">
        <div
          v-for="group in groupedFiltered"
          :key="group.name"
          class="space-y-2"
        >
          <!-- 分组标题 -->
          <button
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-elevated transition-colors"
            @click="toggleGroup(group.name)"
          >
            <UIcon
              :name="collapsedGroups.has(group.name) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
              class="size-4 text-muted"
            />
            <UIcon
              :name="group.name === '未分类' ? 'i-lucide-inbox' : 'i-lucide-folder'"
              class="size-4 text-muted"
            />
            <span class="text-sm font-medium">{{ group.name }}</span>
            <UBadge
              :label="String(group.items.length)"
              color="neutral"
              variant="subtle"
              size="xs"
            />
          </button>

          <!-- 分组内容 -->
          <TransitionGroup
            v-if="!collapsedGroups.has(group.name)"
            name="sub-list"
            tag="div"
            class="space-y-3 pl-6"
          >
            <SubscriptionItem
              v-for="sub in group.items"
              :key="sub.feedId"
              :subscription="sub"
              @remove="pendingRemove = sub"
              @edit="editingItem = sub"
            />
          </TransitionGroup>
        </div>
      </template>

      <!-- 平铺视图 -->
      <TransitionGroup
        v-else
        name="sub-list"
        tag="div"
        class="space-y-3"
      >
        <SubscriptionItem
          v-for="sub in filtered"
          :key="sub.feedId"
          :subscription="sub"
          @remove="pendingRemove = sub"
          @edit="editingItem = sub"
        />
      </TransitionGroup>
    </template>

    <!-- 取消订阅确认弹窗 -->
    <UModal
      v-model:open="confirmOpen"
      title="取消订阅"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <p class="text-sm text-muted">
          取消订阅后「{{ pendingRemove?.title }}」将从你的订阅列表移除，已抓取的条目仍保留。
        </p>
        <UAlert
          v-if="confirmError"
          color="error"
          variant="soft"
          :title="confirmError"
          icon="i-lucide-circle-alert"
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
          color="error"
          :loading="confirming"
          @click="confirmRemove"
        >
          取消订阅
        </UButton>
      </template>
    </UModal>

    <!-- 编辑弹窗 -->
    <EditSubscriptionModal
      :subscription="editingItem"
      @close="editingItem = null"
      @saved="onEdited"
    />
  </div>
</template>

<style scoped>
/* 列表增删/移动过渡动画 */
.sub-list-enter-active,
.sub-list-leave-active,
.sub-list-move {
  transition: all 0.25s ease;
}
.sub-list-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.sub-list-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.sub-list-leave-active {
  position: absolute;
  width: 100%;
}
</style>
