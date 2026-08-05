<script setup lang="ts">
import type { FeedStatus } from '~/types/rss'

definePageMeta({
  layout: 'default',
})

const api = useApi()
const userStore = useUserStore()
const toast = useToast()

interface AdminFeed {
  id: string
  url: string
  title: string
  description?: string
  siteUrl?: string
  image?: string
  status: FeedStatus
  errorMessage?: string
  lastFetchedAt?: string
  createdAt: string
}

const feeds = ref<AdminFeed[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const statusFilter = ref<'all' | FeedStatus>('all')
const keyword = ref('')

const editingFeed = ref<AdminFeed | null>(null)
const editForm = ref({ title: '', url: '', description: '', siteUrl: '', image: '' })
const editOpen = computed({
  get: () => editingFeed.value !== null,
  set: (v: boolean) => { if (!v) editingFeed.value = null },
})
const saving = ref(false)
const editError = ref<string | null>(null)

const statusMeta: Record<FeedStatus, { label: string, color: 'success' | 'neutral' | 'error', icon: string }> = {
  active: { label: '活跃', color: 'success', icon: 'i-lucide-circle-check' },
  paused: { label: '已暂停', color: 'neutral', icon: 'i-lucide-circle-pause' },
  error: { label: '错误', color: 'error', icon: 'i-lucide-circle-alert' },
}

const statusFilters = computed(() => {
  const counts = { all: feeds.value.length, active: 0, paused: 0, error: 0 }
  for (const s of feeds.value) counts[s.status]++
  return [
    { label: '全部', value: 'all', badge: counts.all },
    { label: '活跃', value: 'active', badge: counts.active },
    { label: '已暂停', value: 'paused', badge: counts.paused },
    { label: '错误', value: 'error', badge: counts.error },
  ]
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return feeds.value.filter((s) => {
    if (statusFilter.value !== 'all' && s.status !== statusFilter.value) return false
    if (!kw) return true
    return s.title.toLowerCase().includes(kw) || s.url.toLowerCase().includes(kw)
  })
})

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

async function load() {
  loading.value = true
  error.value = null
  try {
    feeds.value = await api.feeds.listAll()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function togglePause(feed: AdminFeed) {
  const newStatus = feed.status === 'paused' ? 'active' : 'paused'
  try {
    await api.feeds.updateStatus(feed.id, newStatus)
    toast.add({ title: newStatus === 'paused' ? '已暂停' : '已恢复', description: feed.title, color: 'success' })
    await load()
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  }
}

async function refetch(feed: AdminFeed) {
  try {
    await api.feeds.refetch(feed.id)
    toast.add({ title: '已触发重新抓取', description: feed.title, color: 'success' })
    await load()
  } catch (e) {
    toast.add({ title: '重新抓取失败', description: errorMessage(e), color: 'error' })
  }
}

function timeAgo(iso?: string): string {
  if (!iso) return '从未抓取'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function openEdit(feed: AdminFeed) {
  editingFeed.value = feed
  editForm.value = {
    title: feed.title ?? '',
    url: feed.url ?? '',
    description: feed.description ?? '',
    siteUrl: feed.siteUrl ?? '',
    image: feed.image ?? '',
  }
  editError.value = null
}

async function saveEdit() {
  if (!editingFeed.value) return
  saving.value = true
  editError.value = null
  try {
    await api.feeds.update(editingFeed.value.id, editForm.value)
    toast.add({ title: '已保存', description: editingFeed.value.title, color: 'success' })
    editingFeed.value = null
    await load()
  } catch (e) {
    editError.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    await userStore.refresh()
  } catch {
    // ignore refresh errors
  }
  if (!userStore.isAdmin) {
    await navigateTo('/')
    return
  }
  await load()
})
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="订阅源管理（管理员）" />
    </template>

    <template #body>
      <div class="max-w-4xl mx-auto w-full px-4 py-6 space-y-4">
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          title="加载失败"
          icon="i-lucide-circle-alert"
        >
          <template #description>{{ error }}</template>
          <template #actions>
            <UButton size="sm" variant="outline" color="neutral" @click="load">重试</UButton>
          </template>
        </UAlert>

        <template v-else>
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <UTabs
              v-model="statusFilter"
              :items="statusFilters"
              :content="false"
              size="sm"
            />
            <UInput
              v-model="keyword"
              icon="i-lucide-search"
              placeholder="搜索名称或 URL…"
              class="w-full sm:w-72"
              clearable
            />
          </div>

          <div v-if="loading" class="space-y-3">
            <USkeleton v-for="i in 5" :key="i" class="h-20 w-full rounded-xl" />
          </div>

          <div v-else-if="!filtered.length" class="flex flex-col items-center gap-3 py-12 text-muted">
            <UIcon name="i-lucide-database" class="size-10" />
            <p class="text-sm">没有匹配的订阅源</p>
          </div>

          <div v-else class="space-y-3">
            <UCard
              v-for="feed in filtered"
              :key="feed.id"
              :ui="feed.status === 'error' ? { root: 'border-red-500/60' } : {}"
            >
              <div class="flex items-start gap-3">
                <UAvatar
                  v-if="feed.image"
                  :src="feed.image"
                  :alt="feed.title"
                  size="lg"
                />
                <UAvatar
                  v-else
                  :text="feed.title?.[0] ?? 'R'"
                  size="lg"
                  :color="feed.status === 'error' ? 'error' : 'primary'"
                />

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-bold truncate">{{ feed.title }}</h3>
                    <UBadge
                      :color="statusMeta[feed.status].color"
                      variant="subtle"
                      size="xs"
                    >
                      <template #leading>
                        <UIcon :name="statusMeta[feed.status].icon" class="size-3" />
                      </template>
                      {{ statusMeta[feed.status].label }}
                    </UBadge>
                  </div>
                  <p class="text-xs text-muted truncate">{{ feed.url }}</p>
                  <p class="text-xs text-muted">最近抓取：{{ timeAgo(feed.lastFetchedAt) }}</p>

                  <div
                    v-if="feed.status === 'error' && feed.errorMessage"
                    class="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2"
                  >
                    <p class="break-all text-xs text-red-600/90">{{ feed.errorMessage }}</p>
                  </div>
                </div>

                <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <UButton
                    v-if="feed.status === 'error'"
                    icon="i-lucide-refresh-cw"
                    size="xs"
                    color="primary"
                    @click="refetch(feed)"
                  >
                    重新抓取
                  </UButton>
                  <UButton
                    :icon="feed.status === 'paused' ? 'i-lucide-play' : 'i-lucide-pause'"
                    size="xs"
                    variant="outline"
                    color="neutral"
                    @click="togglePause(feed)"
                  >
                    {{ feed.status === 'paused' ? '恢复' : '暂停' }}
                  </UButton>
                  <UButton
                    icon="i-lucide-pencil"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    aria-label="编辑"
                    @click="openEdit(feed)"
                  />
                </div>
              </div>
            </UCard>
          </div>
        </template>
      </div>
    </template>

  </UDashboardPanel>

  <UModal
    v-model:open="editOpen"
    title="编辑订阅源"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="订阅名称">
          <UInput v-model="editForm.title" class="w-full" />
        </UFormField>
        <UFormField label="Feed URL" hint="修改后将按新地址抓取">
          <UInput v-model="editForm.url" class="w-full" />
        </UFormField>
        <UFormField label="站点链接">
          <UInput v-model="editForm.siteUrl" class="w-full" />
        </UFormField>
        <UFormField label="描述">
          <UTextarea v-model="editForm.description" class="w-full" :rows="2" />
        </UFormField>
        <UFormField label="图标 URL">
          <UInput v-model="editForm.image" class="w-full" />
        </UFormField>
        <UAlert
          v-if="editError"
          color="error"
          variant="soft"
          :title="editError"
          icon="i-lucide-circle-alert"
        />
      </div>
    </template>
    <template #footer="{ close }">
      <UButton variant="outline" color="neutral" @click="close">取消</UButton>
      <UButton color="primary" :loading="saving" @click="saveEdit">保存</UButton>
    </template>
  </UModal>
</template>
