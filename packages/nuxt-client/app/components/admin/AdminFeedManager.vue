<script setup lang="ts">
import type { AdminFeed, FeedStatus } from '~/types/rss'
import { resolveApiBase } from '~/utils/apiBase'

const api = useApi()
const toast = useToast()
const { public: { apiBaseUrl } } = useRuntimeConfig()

/**
 * BullMQ 任务看板地址（后端 /admin/queues，BullBoard）。
 * 它是后端路由、没有对应的前端页面，所以这里给管理员一个直达入口；
 * 打开后仍要管理员会话才能进（requireAdmin）。
 */
const queueBoardUrl = computed(() => `${resolveApiBase(apiBaseUrl)}/admin/queues`)

/**
 * CouchDB 后台管理页地址（后端 /admin/couchdb，Fauxton 反代）。
 * 与队列看板同样：后端路由、没有对应的前端页面，这里只给管理员一个直达入口；
 * 打开后仍要管理员会话（requireAdmin），且转发身份是 CouchDB 的 `_admin`，别把地址外传。
 */
const couchAdminUrl = computed(() => `${resolveApiBase(apiBaseUrl)}/admin/couchdb/_utils/`)

const feeds = ref<AdminFeed[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const statusFilter = ref<'all' | FeedStatus>('all')
const keyword = ref('')

const editingFeed = ref<AdminFeed | null>(null)
const editForm = ref({
  title: '', url: '', description: '', siteUrl: '', image: '',
  cacheImages: false,
  // 高级参数用字符串承载 UI 输入（留空表示「跟随全局默认」），提交时再规范成 number/null
  maxImageCount: '',
  maxEntryImageBytes: '',
  maxImageWidth: '',
  avifQuality: '',
  maxSourceImageBytes: ''
})
const editOpen = computed({
  get: () => editingFeed.value !== null,
  set: (v: boolean) => { if (!v) editingFeed.value = null }
})
const saving = ref(false)
const editError = ref<string | null>(null)
/** 编辑弹窗内是否展开「高级图片缓存参数」 */
const showAdvancedImages = ref(false)
/** 全局默认图片缓存参数（来自后端环境变量），用于 placeholder 展示默认值 */
const imageDefaults = ref<{ maxImageCount: number, maxEntryImageBytes: number, maxImageWidth: number, avifQuality: number, maxSourceImageBytes: number } | null>(null)

/** 生成高级参数输入框的 placeholder：显示当前全局默认值，未加载到则返回空 */
function imagePlaceholder(value: number | undefined, unit = ''): string {
  if (value === undefined || value === null) return ''
  return `默认 ${value}${unit}`
}

/** 字节数转可读体积，用于「每篇附件体积上限」的默认值提示（1MB = 1048576） */
function formatBytes(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1048576).toFixed(bytes % 1048576 === 0 ? 0 : 1)}MB`
}

const statusMeta: Record<FeedStatus, { label: string, color: 'success' | 'neutral' | 'error', icon: string }> = {
  active: { label: '活跃', color: 'success', icon: 'i-lucide-circle-check' },
  paused: { label: '已暂停', color: 'neutral', icon: 'i-lucide-circle-pause' },
  error: { label: '错误', color: 'error', icon: 'i-lucide-circle-alert' }
}

const statusFilters = computed(() => {
  const counts = { all: feeds.value.length, active: 0, paused: 0, error: 0 }
  for (const s of feeds.value) counts[s.status]++
  return [
    { label: '全部', value: 'all', badge: counts.all },
    { label: '活跃', value: 'active', badge: counts.active },
    { label: '已暂停', value: 'paused', badge: counts.paused },
    { label: '错误', value: 'error', badge: counts.error }
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
  // 拉取全局默认图片缓存参数（供 placeholder 展示；失败静默，仅影响提示文案）
  try {
    imageDefaults.value = await api.feeds.imageDefaults()
  } catch {
    imageDefaults.value = null
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

/**
 * 删除源（两步确认）。
 *
 * 第一次点只弹确认框，把"会删掉什么"写清楚；后端若有别的订阅者会回 409，
 * 此时不再自动强删 —— 而是把订阅者列出来，让管理员再点一次"仍然删除"。
 * 删除不可逆（源库与条目都会被清掉），所以绝不能一点就删。
 */
const deletingFeed = ref<AdminFeed | null>(null)
const deleteOpen = computed({
  get: () => deletingFeed.value !== null,
  set: (v: boolean) => { if (!v) deletingFeed.value = null }
})
const deleting = ref(false)
/** 409 返回的订阅者列表：非空时弹窗会把"仍然删除"暴露出来 */
const deleteSubscribers = ref<Array<{ userId: string, email?: string, via: string }>>([])

function openDelete(feed: AdminFeed) {
  deletingFeed.value = feed
  deleteSubscribers.value = []
}

async function confirmDelete(force = false) {
  if (!deletingFeed.value) return
  deleting.value = true
  try {
    const res = await api.feeds.remove(deletingFeed.value.id, { force })
    toast.add({
      title: '已删除订阅源',
      description: `${res.title ?? deletingFeed.value.title}（清理了 ${res.purgedUsers} 个用户的副本）`,
      color: 'success'
    })
    deletingFeed.value = null
    deleteSubscribers.value = []
    await load()
  } catch (e: unknown) {
    const err = e as { data?: { code?: string, subscribers?: typeof deleteSubscribers.value, error?: string } }
    if (err.data?.code === 'feed_has_subscribers') {
      // 有别人在订阅：留在弹窗里展示名单，由管理员决定是否强删
      deleteSubscribers.value = err.data.subscribers ?? []
    } else {
      toast.add({ title: '删除失败', description: errorMessage(e), color: 'error' })
      deletingFeed.value = null
    }
  } finally {
    deleting.value = false
  }
}

/**
 * 孤儿源清理（零订阅源批量暂停）。
 *
 * 设计意图：调度器只看 status=active，不看有没有人订阅，所以被退订干净的源会一直抓。
 * 这里只把它暂停、不删除 —— 注册表与源库都留着，有人重新订阅时自动恢复
 * （后端在订阅写入点直接恢复，另有每小时兜底扫描）。
 *
 * 列表的分页：后端一次最多回 2000 条，但**统计（activeOrphans / alreadyPaused）始终是
 * 全量的**，只有 `orphans` 数组按 limit 截断。所以这里先取一页，滚到底再追加下一页 ——
 * 不能一次渲染 578 条（弹窗会卡），也不该只渲染前 20 条（用户以为只有这些）。
 */
const ORPHAN_PAGE_SIZE = 50

const orphansOpen = ref(false)
const orphansLoading = ref(false)
const orphansLoadingMore = ref(false)
const orphansPausing = ref(false)
/** 已经取到手的孤儿源（逐页追加） */
const orphanItems = ref<OrphanItem[]>([])
/** 是否还有下一页：拿到空页或数量对不上时置 false */
const orphanHasMore = ref(false)
const orphanScan = ref<{
  total: number
  referenced: number
  orphans: OrphanItem[]
  activeOrphans: number
  alreadyPaused: number
  scanFailures: number
} | null>(null)

interface OrphanItem {
  id: string
  url: string
  title: string
  status: string
  pausedBySystem: boolean | null
  lastFetchedAt: string | null
}

/** 自动清理策略（后端环境变量决定：零订阅满 N 天暂停、暂停满 M 天删除） */
const orphanPolicyInfo = ref<{
  pauseAfterDays: number
  deleteAfterDays: number
  batchLimit: number
  enabled: boolean
  /** 当前值来自哪里：settings=站点设置里改过；env=环境变量默认 */
  source: 'settings' | 'env'
} | null>(null)
/** 「立即执行一轮」进行中 */
const orphanSweeping = ref(false)

/** 可编辑的策略表单（与 orphanPolicyInfo 分开：editing 未保存时不该影响展示） */
const policyForm = ref({ pauseAfterDays: 7, deleteAfterDays: 30 })
const policySaving = ref(false)
/** 表单是否与已保存值不同（只有改动过才允许保存） */
const policyDirty = computed(() => {
  const p = orphanPolicyInfo.value
  if (!p) return false
  return policyForm.value.pauseAfterDays !== p.pauseAfterDays
    || policyForm.value.deleteAfterDays !== p.deleteAfterDays
})

/** 保存规则（写进站点设置，立即生效） */
async function savePolicy() {
  policySaving.value = true
  try {
    const saved = await api.feeds.saveOrphanPolicy({
      pauseAfterDays: policyForm.value.pauseAfterDays,
      deleteAfterDays: policyForm.value.deleteAfterDays
    })
    orphanPolicyInfo.value = saved
    policyForm.value = { pauseAfterDays: saved.pauseAfterDays, deleteAfterDays: saved.deleteAfterDays }
    toast.add({ title: '规则已保存', description: '下一次自动扫描起生效，无需重启', color: 'success' })
  } catch (e: unknown) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    policySaving.value = false
  }
}

async function openOrphans() {
  orphansOpen.value = true
  void loadOrphanPolicy()
  await scanOrphans()
}

async function loadOrphanPolicy() {
  try {
    orphanPolicyInfo.value = await api.feeds.orphanPolicy()
    policyForm.value = {
      pauseAfterDays: orphanPolicyInfo.value.pauseAfterDays,
      deleteAfterDays: orphanPolicyInfo.value.deleteAfterDays
    }
  } catch {
    // 策略只影响说明文案，取不到就退化成不显示
  }
}

/** 立刻跑一轮自动清理（等价于定时任务那一轮，不等待冷静期） */
async function runOrphanSweep() {
  orphanSweeping.value = true
  try {
    const r = await api.feeds.sweepOrphans()
    toast.add({
      title: '已执行一轮自动清理',
      description: `标记 ${r.marked}、清除 ${r.cleared}、暂停 ${r.paused}、删除 ${r.deleted}`,
      color: 'success'
    })
    await scanOrphans()
    await load()
  } catch (e: unknown) {
    const err = e as { data?: { error?: string } }
    toast.add({ title: '执行失败', description: err.data?.error ?? errorMessage(e), color: 'error' })
  } finally {
    orphanSweeping.value = false
  }
}

async function scanOrphans() {
  orphansLoading.value = true
  orphanItems.value = []
  orphanHasMore.value = false
  try {
    const res = await api.feeds.orphans(ORPHAN_PAGE_SIZE)
    orphanScan.value = res
    orphanItems.value = res.orphans
    // "还有更多"的判据：本页取满了，且总孤儿数大于已取的数量
    const totalOrphans = res.activeOrphans + res.alreadyPaused
    orphanHasMore.value = res.orphans.length === ORPHAN_PAGE_SIZE && orphanItems.value.length < totalOrphans
  } catch (e) {
    toast.add({ title: '扫描失败', description: errorMessage(e), color: 'error' })
  } finally {
    orphansLoading.value = false
  }
}

/** 滚到底时追加下一页（后端按 limit 截断，offset 用已取数量模拟） */
async function loadMoreOrphans() {
  if (orphansLoadingMore.value || !orphanHasMore.value) return
  orphansLoadingMore.value = true
  try {
    // 后端没有 offset 参数，用"这次要多取多少"来表达：多取一页，再按 id 去掉已有的。
    const next = await api.feeds.orphans(orphanItems.value.length + ORPHAN_PAGE_SIZE)
    const known = new Set(orphanItems.value.map(i => i.id))
    const appended = next.orphans.filter(i => !known.has(i.id))
    orphanItems.value = [...orphanItems.value, ...appended]
    // 用全量统计（而非本页数组长度）判断是否到底：统计始终是全部孤儿源的数量
    const totalOrphans = next.activeOrphans + next.alreadyPaused
    orphanHasMore.value = appended.length > 0 && orphanItems.value.length < totalOrphans
    // 只同步统计字段，**不覆盖 orphanScan.orphans** —— 它只是"本次请求的那一页"，
    // 拿来渲染会和逐步追加的 orphanItems 打架（列表突然变短）。
    if (orphanScan.value) {
      orphanScan.value = {
        ...orphanScan.value,
        total: next.total,
        referenced: next.referenced,
        activeOrphans: next.activeOrphans,
        alreadyPaused: next.alreadyPaused,
        scanFailures: next.scanFailures
      }
    }
  } catch (e) {
    toast.add({ title: '加载更多失败', description: errorMessage(e), color: 'error' })
  } finally {
    orphansLoadingMore.value = false
  }
}

/** 列表容器滚动到底部附近（提前 48px）就取下一页 */
function onOrphanScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
    void loadMoreOrphans()
  }
}

async function pauseAllOrphans(force = false) {
  orphansPausing.value = true
  try {
    // 默认遵守冷静期：只暂停"零订阅已持续足够久"的源。force 才跳过（管理员看过名单后确认）
    const res = await api.feeds.pauseOrphans({ force })
    toast.add({
      title: `已暂停 ${res.paused} 个孤儿源`,
      description: force
        ? '已跳过冷静期，有人订阅时仍会自动恢复'
        : (res.skipped > 0
            ? `跳过 ${res.skipped} 个（尚未满冷静期或刚被订阅）；未满天数的源会在后续自动轮次处理`
            : '有人订阅时自动恢复'),
      color: 'success'
    })
    await scanOrphans()
    await load()
  } catch (e: unknown) {
    // 后端在"读用户库失败"时返回 503 且一个都不暂停，把原因如实显示
    const err = e as { data?: { error?: string } }
    toast.add({ title: '暂停失败', description: err.data?.error ?? errorMessage(e), color: 'error' })
  } finally {
    orphansPausing.value = false
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
    cacheImages: feed.cacheImages ?? false,
    maxImageCount: feed.maxImageCount != null ? String(feed.maxImageCount) : '',
    maxEntryImageBytes: feed.maxEntryImageBytes != null ? String(feed.maxEntryImageBytes) : '',
    maxImageWidth: feed.maxImageWidth != null ? String(feed.maxImageWidth) : '',
    avifQuality: feed.avifQuality != null ? String(feed.avifQuality) : '',
    maxSourceImageBytes: feed.maxSourceImageBytes != null ? String(feed.maxSourceImageBytes) : ''
  }
  editError.value = null
}

async function saveEdit() {
  if (!editingFeed.value) return
  saving.value = true
  editError.value = null
  try {
    // 高级参数输入框允许留空（→ null 表示跟随全局默认）；数字字段做规范化
    const patch = {
      ...editForm.value,
      maxImageCount: toImageNumber(editForm.value.maxImageCount),
      maxEntryImageBytes: toImageNumber(editForm.value.maxEntryImageBytes),
      maxImageWidth: toImageNumber(editForm.value.maxImageWidth),
      avifQuality: toImageNumber(editForm.value.avifQuality),
      maxSourceImageBytes: toImageNumber(editForm.value.maxSourceImageBytes)
    }
    await api.feeds.update(editingFeed.value.id, patch)
    toast.add({ title: '已保存', description: editingFeed.value.title, color: 'success' })
    editingFeed.value = null
    await load()
  } catch (e) {
    editError.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

/** 把输入框里的空字符串规范成 null（后端据此回退全局默认）；非空合法数字保留 */
function toImageNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return null
  const n = Math.floor(Number(v))
  return n >= 0 ? n : null
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
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
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <UTabs
          v-model="statusFilter"
          :items="statusFilters"
          :content="false"
          size="sm"
        />
        <div class="flex w-full items-center gap-2 sm:w-auto">
          <UInput
            v-model="keyword"
            icon="i-lucide-search"
            placeholder="搜索名称或 URL…"
            class="flex-1 sm:w-72"
            clearable
          />
          <UButton
            :to="queueBoardUrl"
            target="_blank"
            rel="noopener"
            icon="i-lucide-list-tree"
            color="neutral"
            variant="outline"
            size="sm"
            class="shrink-0"
          >
            队列看板
          </UButton>
          <UButton
            :to="couchAdminUrl"
            target="_blank"
            rel="noopener"
            icon="i-lucide-database"
            color="neutral"
            variant="outline"
            size="sm"
            class="shrink-0"
            title="CouchDB 后台管理页（Fauxton）"
          >
            数据库控制台
          </UButton>
          <UButton
            icon="i-lucide-sparkles"
            color="neutral"
            variant="outline"
            size="sm"
            class="shrink-0"
            title="找出没有任何人订阅的源，批量暂停抓取"
            @click="openOrphans"
          >
            清理孤儿源
          </UButton>
        </div>
      </div>

      <div
        v-if="loading"
        class="space-y-3"
      >
        <USkeleton
          v-for="i in 5"
          :key="i"
          class="h-20 w-full rounded-xl"
        />
      </div>

      <div
        v-else-if="!filtered.length"
        class="flex flex-col items-center gap-3 py-12 text-muted"
      >
        <UIcon
          name="i-lucide-database"
          class="size-10"
        />
        <p class="text-sm">
          没有匹配的订阅源
        </p>
      </div>

      <div
        v-else
        class="space-y-3"
      >
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
                <h3 class="font-bold truncate">
                  {{ feed.title }}
                </h3>
                <UBadge
                  :color="statusMeta[feed.status].color"
                  variant="subtle"
                  size="xs"
                >
                  <template #leading>
                    <UIcon
                      :name="statusMeta[feed.status].icon"
                      class="size-3"
                    />
                  </template>
                  {{ statusMeta[feed.status].label }}
                </UBadge>
                <UBadge
                  v-if="feed.cacheImages"
                  color="info"
                  variant="subtle"
                  size="xs"
                >
                  <template #leading>
                    <UIcon
                      name="i-lucide-image-down"
                      class="size-3"
                    />
                  </template>
                  全量缓存
                </UBadge>
              </div>
              <p class="text-xs text-muted truncate">
                {{ feed.url }}
              </p>
              <p class="text-xs text-muted">
                最近抓取：{{ timeAgo(feed.lastFetchedAt) }}
              </p>

              <div
                v-if="feed.status === 'error' && feed.errorMessage"
                class="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2"
              >
                <p class="break-all text-xs text-red-600/90">
                  {{ feed.errorMessage }}
                </p>
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
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                variant="ghost"
                color="error"
                aria-label="删除"
                @click="openDelete(feed)"
              />
            </div>
          </div>
        </UCard>
      </div>
    </template>

    <UModal
      v-model:open="orphansOpen"
      title="孤儿源清理"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-muted">
            找出<strong>没有任何用户或 Bot 引用</strong>的订阅源。抓取调度只看启用状态、不看是否有人订阅，
            这些源会一直占用抓取配额。
          </p>
          <p class="text-xs text-muted">
            处理方式是<strong>暂停</strong>而非删除：注册表与已抓内容都保留，有人重新订阅时自动恢复抓取。
            管理员手动暂停的源不会被自动恢复。
          </p>

          <div
            v-if="orphanPolicyInfo"
            class="rounded-lg border border-default p-3 space-y-2"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-medium">
                自动清理规则
              </p>
              <UBadge
                size="sm"
                :color="orphanPolicyInfo.enabled ? 'success' : 'neutral'"
                variant="soft"
              >
                {{ orphanPolicyInfo.enabled ? '已启用' : '已停用' }}
              </UBadge>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <UFormField
                label="零订阅满多少天 → 暂停抓取"
                help="0 = 不自动暂停"
              >
                <UInput
                  v-model.number="policyForm.pauseAfterDays"
                  type="number"
                  min="0"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="暂停满多少天 → 自动删除"
                help="0 = 永不自动删除"
              >
                <UInput
                  v-model.number="policyForm.deleteAfterDays"
                  type="number"
                  min="0"
                  class="w-full"
                />
              </UFormField>
            </div>
            <p class="text-xs text-muted">
              天数看的是「持续无人订阅」的时长，不是某一刻没人订阅——避免误伤刚退订、正在重新订阅，
              或多设备同步尚未完成的源。删除前会再确认一次确实无人订阅。
              <template v-if="orphanPolicyInfo.source === 'env'">
                当前值来自环境变量默认。
              </template>
            </p>
            <div class="flex items-center gap-2">
              <UButton
                size="xs"
                color="primary"
                :loading="policySaving"
                :disabled="!policyDirty"
                @click="savePolicy"
              >
                保存规则
              </UButton>
              <span class="text-xs text-muted">保存后立即生效，无需重启</span>
            </div>
          </div>

          <div
            v-if="orphanScan"
            class="rounded-lg border border-default px-3 py-2 text-sm"
          >
            <p>
              共 <strong>{{ orphanScan.total }}</strong> 个源，其中
              <strong>{{ orphanScan.referenced }}</strong> 个有引用；
              孤儿源 <strong>{{ orphanScan.activeOrphans }}</strong> 个仍在抓取
              <span v-if="orphanScan.alreadyPaused > 0">（{{ orphanScan.alreadyPaused }} 个已暂停）</span>
            </p>
            <p class="mt-1 text-xs text-muted">
              列表已显示 {{ orphanItems.length }} 条<span v-if="orphanHasMore">，滚到底继续加载</span>
            </p>
            <UAlert
              v-if="orphanScan.scanFailures > 0"
              class="mt-2"
              color="warning"
              variant="soft"
              icon="i-lucide-triangle-alert"
              :title="`有 ${orphanScan.scanFailures} 个用户库读取失败`"
              description="无法确认订阅关系，批量暂停会被拒绝执行（避免误停别人正在看的源）。"
            />
          </div>

          <div
            v-if="orphansLoading"
            class="space-y-2"
          >
            <USkeleton class="h-10 w-full" />
            <USkeleton class="h-10 w-full" />
          </div>

          <div
            v-else-if="orphanItems.length > 0"
            class="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-default p-2"
            @scroll="onOrphanScroll"
          >
            <div
              v-for="item in orphanItems"
              :key="item.id"
              class="rounded px-2 py-1 text-xs"
            >
              <p class="truncate font-medium">
                {{ item.title }}
                <span
                  v-if="item.pausedBySystem"
                  class="ml-1 text-muted"
                >（已暂停）</span>
              </p>
              <p class="truncate text-muted">
                {{ item.url }}
              </p>
            </div>
            <div
              v-if="orphanHasMore || orphansLoadingMore"
              class="px-2 py-2 text-center"
            >
              <UButton
                v-if="!orphansLoadingMore"
                variant="ghost"
                color="neutral"
                size="xs"
                @click="loadMoreOrphans"
              >
                加载更多（已显示 {{ orphanItems.length }} 条）
              </UButton>
              <span
                v-else
                class="text-xs text-muted"
              >加载中…</span>
            </div>
            <p
              v-else
              class="px-2 py-1 text-center text-xs text-muted"
            >
              已全部显示
            </p>
          </div>
        </div>
      </template>
      <template #footer="{ close }">
        <UButton
          variant="outline"
          color="neutral"
          @click="close"
        >
          关闭
        </UButton>
        <UButton
          variant="outline"
          color="neutral"
          icon="i-lucide-play"
          :loading="orphanSweeping"
          title="立即执行一轮自动清理（标记新的孤儿、暂停满冷静期的、删除满期限的）"
          @click="runOrphanSweep"
        >
          立即执行一轮
        </UButton>
        <UButton
          v-if="orphanScan && orphanScan.activeOrphans > 0 && orphanScan.scanFailures === 0"
          variant="ghost"
          color="error"
          :loading="orphansPausing"
          title="跳过冷静期，立刻暂停所有仍在抓的孤儿源（仅在确认名单后使用）"
          @click="pauseAllOrphans(true)"
        >
          强制全部暂停
        </UButton>
      </template>
    </UModal>

    <UModal
      v-model:open="deleteOpen"
      title="删除订阅源"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm">
            确定要删除
            <span class="font-semibold">{{ deletingFeed?.title }}</span>
            吗？此操作不可撤销。
          </p>
          <p class="break-all text-xs text-muted">
            {{ deletingFeed?.url }}
          </p>
          <ul class="list-disc space-y-1 pl-5 text-xs text-muted">
            <li>该源的 CouchDB 库与全部已抓条目</li>
            <li>所有订阅者库里的订阅关系、条目副本与源信息</li>
            <li>Bot 对该源的引用与同步水位</li>
          </ul>

          <UAlert
            v-if="deleteSubscribers.length > 0"
            color="warning"
            variant="soft"
            icon="i-lucide-users"
            title="这个源还有订阅者"
          >
            <template #description>
              <p class="text-xs">
                删除会同时清掉他们的阅读内容。确认要继续请点「仍然删除」。
              </p>
              <ul class="mt-1 list-disc pl-4 text-xs">
                <li
                  v-for="sub in deleteSubscribers"
                  :key="sub.userId"
                  class="break-all"
                >
                  {{ sub.email ?? sub.userId }}
                  <span class="text-muted">（{{ sub.via === 'bot' ? 'Bot 引用' : '订阅' }}）</span>
                </li>
              </ul>
            </template>
          </UAlert>
        </div>
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
          v-if="deleteSubscribers.length === 0"
          color="error"
          :loading="deleting"
          @click="confirmDelete(false)"
        >
          删除
        </UButton>
        <UButton
          v-else
          color="error"
          :loading="deleting"
          @click="confirmDelete(true)"
        >
          仍然删除
        </UButton>
      </template>
    </UModal>

    <UModal
      v-model:open="editOpen"
      title="编辑订阅源"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField label="订阅名称">
            <UInput
              v-model="editForm.title"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Feed URL"
            hint="修改后将按新地址抓取"
          >
            <UInput
              v-model="editForm.url"
              class="w-full"
            />
          </UFormField>
          <UFormField label="站点链接">
            <UInput
              v-model="editForm.siteUrl"
              class="w-full"
            />
          </UFormField>
          <UFormField label="描述">
            <UTextarea
              v-model="editForm.description"
              class="w-full"
              :rows="2"
            />
          </UFormField>
          <UFormField label="图标 URL">
            <UInput
              v-model="editForm.image"
              class="w-full"
            />
          </UFormField>

          <div class="rounded-xl border border-default p-3 space-y-3">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  缓存全部图片
                </p>
                <p class="text-xs text-muted">
                  开启后每篇条目不限张数、不限体积，适合漫画等图片密集的源（离线可看）。
                </p>
              </div>
              <USwitch
                v-model="editForm.cacheImages"
                name="cacheImages"
              />
            </div>

            <div class="flex items-center justify-between border-t border-default pt-2">
              <button
                type="button"
                class="text-xs text-muted hover:text-primary inline-flex items-center gap-1"
                @click="showAdvancedImages = !showAdvancedImages"
              >
                <UIcon
                  :name="showAdvancedImages ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                  class="size-3"
                />
                高级参数（可选，留空跟随全局默认）
              </button>
            </div>

            <div
              v-if="showAdvancedImages"
              class="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              <UFormField label="每篇最多缓存张数">
                <UInput
                  v-model="editForm.maxImageCount"
                  type="number"
                  min="0"
                  :placeholder="imagePlaceholder(imageDefaults?.maxImageCount)"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="每篇附件体积上限 (字节)">
                <UInput
                  v-model="editForm.maxEntryImageBytes"
                  type="number"
                  min="0"
                  :placeholder="imagePlaceholder(imageDefaults?.maxEntryImageBytes, 'B')"
                  class="w-full"
                />
              </UFormField>
              <p class="text-xs text-muted sm:col-span-2">
                每篇默认最多缓存 {{ imageDefaults?.maxImageCount ?? 6 }} 张、附件总体积上限
                {{ formatBytes(imageDefaults?.maxEntryImageBytes) || '1MB' }}；
                按正文顺序取图，任一上限先到即停止缓存后续图片，首图必留。
              </p>
              <UFormField label="压缩最大宽度 (px)">
                <UInput
                  v-model="editForm.maxImageWidth"
                  type="number"
                  min="0"
                  :placeholder="imagePlaceholder(imageDefaults?.maxImageWidth, 'px')"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="AVIF 质量">
                <UInput
                  v-model="editForm.avifQuality"
                  type="number"
                  min="0"
                  max="100"
                  :placeholder="imagePlaceholder(imageDefaults?.avifQuality)"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="源图大小上限 (字节)">
                <UInput
                  v-model="editForm.maxSourceImageBytes"
                  type="number"
                  min="0"
                  :placeholder="imagePlaceholder(imageDefaults?.maxSourceImageBytes, 'B')"
                  class="w-full"
                />
              </UFormField>
            </div>
          </div>

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
        <UButton
          variant="outline"
          color="neutral"
          @click="close"
        >
          取消
        </UButton>
        <UButton
          color="primary"
          :loading="saving"
          @click="saveEdit"
        >
          保存
        </UButton>
      </template>
    </UModal>
  </div>
</template>
