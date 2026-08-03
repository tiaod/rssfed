<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { SubscriptionItem } from '~/composables/useCouchDb'

definePageMeta({
  layout: 'default'
})

interface BotInfo {
  id: string
  name: string
  preferredUsername: string
  description?: string
  avatarUrl?: string
  isActive: boolean
}

interface AttachedFeed {
  feedId: string
  title: string
  url?: string
}

interface FollowingItem {
  id: string
  handle: string
  actorName?: string
  actorAvatar?: string
  status: 'pending' | 'accepted' | 'rejected'
}

interface TimelineItem {
  id: string
  actorId: string
  actorName?: string
  actorAvatar?: string
  content: string
  url?: string
  publishedAt: string
}

const api = useApi()
const db = useCouchDb()
const toast = useToast()
const route = useRoute()
const botId = String(route.params.id)

const bot = ref<BotInfo | null>(null)
const following = ref<FollowingItem[]>([])
const timeline = ref<TimelineItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// ── 关联订阅源 ──
const attachedFeeds = ref<AttachedFeed[]>([])
const subscriptions = ref<SubscriptionItem[]>([])
const attachOpen = ref(false)
const attachLoading = ref(false)
const attachError = ref<string | null>(null)
const selectedFeedId = ref('')

// ── 停用 / 删除 ──
const toggleActiveLoading = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

const handle = ref('')
const followLoading = ref(false)
const timelineLoading = ref(false)

const statusMeta: Record<FollowingItem['status'], { label: string, color: 'success' | 'warning' | 'error' }> = {
  accepted: { label: '已接受', color: 'success' },
  pending: { label: '等待对方接受', color: 'warning' },
  rejected: { label: '已被拒绝', color: 'error' }
}

// 提取 $fetch 抛出的错误信息（服务端返回 { error } 或网络错误 message）
function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

async function loadData() {
  try {
    const [bots, followingList, posts, feedList] = await Promise.all([
      api.bots.list(),
      api.bots.following(botId),
      api.bots.timeline(botId),
      api.bots.feeds(botId)
    ])
    bot.value = bots.find(b => b.id === botId) ?? null
    following.value = followingList
    timeline.value = posts
    attachedFeeds.value = feedList
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
  // 订阅列表用于"添加订阅源"选择，加载失败不阻塞主流程
  try {
    subscriptions.value = await db.listSubscriptions()
  } catch {
    subscriptions.value = []
  }
}

/** 重新加载关联的订阅源与可用订阅列表 */
async function loadFeeds() {
  const [feedList, subs] = await Promise.all([
    api.bots.feeds(botId),
    db.listSubscriptions().catch(() => [] as SubscriptionItem[])
  ])
  attachedFeeds.value = feedList
  subscriptions.value = subs
}

// 可添加的订阅源 = 已订阅但尚未关联到该 Bot 的
const attachOptions = computed(() => {
  const attached = new Set(attachedFeeds.value.map(f => f.feedId))
  return subscriptions.value
    .filter(s => !attached.has(s.id))
    .map(s => ({ label: s.title, value: s.id }))
})

async function addFeed() {
  if (!selectedFeedId.value || attachLoading.value) return
  attachLoading.value = true
  attachError.value = null
  try {
    await api.bots.attachFeed(botId, selectedFeedId.value)
    toast.add({ title: '已关联订阅源', color: 'success' })
    attachOpen.value = false
    selectedFeedId.value = ''
    await loadFeeds()
  } catch (e) {
    attachError.value = errorMessage(e)
  } finally {
    attachLoading.value = false
  }
}

async function removeFeed(feedId: string) {
  try {
    await api.bots.detachFeed(botId, feedId)
    toast.add({ title: '已移除订阅源', color: 'success' })
    await loadFeeds()
  } catch (e) {
    toast.add({ title: '移除失败', description: errorMessage(e), color: 'error' })
  }
}

/** 停用 / 启用机器人 */
async function toggleActive() {
  if (!bot.value || toggleActiveLoading.value) return
  toggleActiveLoading.value = true
  const next = !bot.value.isActive
  try {
    await api.bots.update(botId, { isActive: next })
    bot.value = { ...bot.value, isActive: next }
    toast.add({ title: next ? '已启用' : '已停用', color: 'success' })
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  } finally {
    toggleActiveLoading.value = false
  }
}

/** 删除机器人（级联删除关联订阅源、出站记录、关注关系） */
async function deleteBot() {
  deleting.value = true
  try {
    await api.bots.remove(botId)
    toast.add({ title: '机器人已删除', color: 'success' })
    await navigateTo('/bots')
  } catch (e) {
    toast.add({ title: '删除失败', description: errorMessage(e), color: 'error' })
  } finally {
    deleting.value = false
  }
}

const botMenuItems = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: bot.value?.isActive ? '停用' : '启用',
      icon: bot.value?.isActive ? 'i-lucide-pause' : 'i-lucide-play',
      onSelect: toggleActive
    }
  ],
  [
    {
      label: '删除机器人',
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => { deleteOpen.value = true }
    }
  ]
])

onMounted(loadData)

async function loadFollowing() {
  following.value = await api.bots.following(botId)
}

async function refreshTimeline() {
  timelineLoading.value = true
  try {
    timeline.value = await api.bots.timeline(botId)
  } finally {
    timelineLoading.value = false
  }
}

async function follow() {
  const target = handle.value.trim()
  if (!target || followLoading.value) return
  followLoading.value = true
  try {
    await api.bots.follow(botId, target)
    handle.value = ''
    toast.add({ title: '已发送关注请求', description: target, color: 'success' })
    await loadFollowing()
  } catch (e) {
    toast.add({ title: '关注失败', description: errorMessage(e), color: 'error' })
  } finally {
    followLoading.value = false
  }
}

async function unfollow(item: FollowingItem) {
  try {
    await api.bots.unfollow(botId, item.handle)
    toast.add({ title: '已取消关注', description: item.handle, color: 'success' })
    await loadFollowing()
  } catch (e) {
    toast.add({ title: '取关失败', description: errorMessage(e), color: 'error' })
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar>
        <template #left>
          <UButton
            icon="i-lucide-arrow-left"
            variant="ghost"
            color="neutral"
            to="/bots"
          />
        </template>
        <div class="min-w-0">
          <div class="text-sm font-semibold truncate">
            {{ bot?.name ?? '机器人' }}
          </div>
          <div
            v-if="bot"
            class="text-xs text-muted truncate"
          >
            @{{ bot.preferredUsername }} · {{ bot.isActive ? '运行中' : '已停用' }}
          </div>
        </div>

        <template #right>
          <UDropdownMenu :items="botMenuItems">
            <UButton
              icon="i-lucide-more-horizontal"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="机器人操作"
            />
          </UDropdownMenu>
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

      <div
        v-else-if="loading"
        class="flex justify-center py-12"
      >
        <ULoading />
      </div>

      <div
        v-else-if="!bot"
        class="flex flex-col items-center py-12 gap-4"
      >
        <UIcon
          name="i-lucide-bot-off"
          class="size-12 text-muted"
        />
        <p class="text-muted">
          机器人不存在或无权访问
        </p>
        <UButton
          to="/bots"
          variant="outline"
          color="neutral"
        >
          返回列表
        </UButton>
      </div>

      <div
        v-else
        class="grid gap-6 lg:grid-cols-[1fr_320px]"
      >
        <!-- 左栏：Bot 视角时间线 -->
        <div>
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-bold">
              关注的动态
            </h2>
            <UButton
              icon="i-lucide-refresh-cw"
              variant="ghost"
              color="neutral"
              size="sm"
              :loading="timelineLoading"
              @click="refreshTimeline"
            >
              刷新
            </UButton>
          </div>

          <div
            v-if="!timeline.length"
            class="flex flex-col items-center py-10 gap-3 text-muted"
          >
            <UIcon
              name="i-lucide-inbox"
              class="size-10"
            />
            <p class="text-sm">
              还没有动态，先关注一些联邦宇宙用户吧
            </p>
          </div>

          <div class="space-y-3">
            <UCard
              v-for="post in timeline"
              :key="post.id"
            >
              <div class="flex gap-3">
                <UAvatar
                  :src="post.actorAvatar"
                  :text="(post.actorName ?? 'U')?.[0]"
                  size="md"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold truncate">{{ post.actorName ?? post.actorId }}</span>
                    <span class="text-xs text-muted shrink-0">{{ formatTime(post.publishedAt) }}</span>
                  </div>
                  <p class="mt-1 text-sm whitespace-pre-line break-words">
                    {{ post.content }}
                  </p>
                  <a
                    v-if="post.url"
                    :href="post.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    查看原文
                    <UIcon
                      name="i-lucide-external-link"
                      class="size-3"
                    />
                  </a>
                </div>
              </div>
            </UCard>
          </div>
        </div>

        <!-- 右栏：关联订阅源 + 关注管理 -->
        <div class="space-y-4">
          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h3 class="font-bold">
                  订阅源（{{ attachedFeeds.length }}）
                </h3>
                <UButton
                  icon="i-lucide-plus"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  :disabled="attachOptions.length === 0"
                  @click="attachOpen = true"
                >
                  添加
                </UButton>
              </div>
            </template>

            <div
              v-if="!attachedFeeds.length"
              class="py-4 text-center text-sm text-muted"
            >
              还没有关联订阅源，添加后新条目将自动发布到 ActivityPub
            </div>

            <ul
              v-else
              class="divide-y divide-default -my-3"
            >
              <li
                v-for="feed in attachedFeeds"
                :key="feed.feedId"
                class="flex items-center gap-2 py-3"
              >
                <UIcon
                  name="i-lucide-rss"
                  class="size-4 text-muted shrink-0"
                />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">
                    {{ feed.title }}
                  </div>
                  <div
                    v-if="feed.url"
                    class="text-xs text-muted truncate"
                  >
                    {{ feed.url }}
                  </div>
                </div>
                <UButton
                  icon="i-lucide-x"
                  variant="ghost"
                  color="error"
                  size="xs"
                  aria-label="移除订阅源"
                  @click="removeFeed(feed.feedId)"
                />
              </li>
            </ul>
          </UCard>

          <UCard>
            <template #header>
              <h3 class="font-bold">
                关注用户
              </h3>
            </template>
            <div class="flex gap-2">
              <UInput
                v-model="handle"
                placeholder="@alice@example.com"
                class="flex-1"
                @keyup.enter="follow"
              />
              <UButton
                icon="i-lucide-user-plus"
                color="primary"
                :loading="followLoading"
                @click="follow"
              >
                关注
              </UButton>
            </div>
            <p class="mt-2 text-xs text-muted">
              输入联邦宇宙句柄（如 @alice@example.com）或 actor URL
            </p>
          </UCard>

          <UCard>
            <template #header>
              <h3 class="font-bold">
                正在关注（{{ following.length }}）
              </h3>
            </template>
            <div
              v-if="!following.length"
              class="py-4 text-center text-sm text-muted"
            >
              还没有关注任何人
            </div>
            <ul
              v-else
              class="divide-y divide-default -my-3"
            >
              <li
                v-for="item in following"
                :key="item.id"
                class="flex items-center gap-2 py-3"
              >
                <UAvatar
                  :src="item.actorAvatar"
                  :text="(item.actorName ?? item.handle)?.[0] ?? 'F'"
                  size="sm"
                />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">
                    {{ item.actorName ?? item.handle }}
                  </div>
                  <div class="text-xs text-muted truncate">
                    {{ item.handle }}
                  </div>
                </div>
                <UBadge
                  :color="statusMeta[item.status].color"
                  variant="subtle"
                  size="xs"
                >
                  {{ statusMeta[item.status].label }}
                </UBadge>
                <UButton
                  icon="i-lucide-user-minus"
                  variant="ghost"
                  color="error"
                  size="xs"
                  aria-label="取消关注"
                  @click="unfollow(item)"
                />
              </li>
            </ul>
          </UCard>
        </div>
      </div>
      <!-- 添加订阅源弹窗 -->
      <UModal
        v-model:open="attachOpen"
        title="添加订阅源"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <p class="text-sm text-muted mb-3">
            从已订阅的源中选择，新条目会自动通过该机器人发布到 ActivityPub。
          </p>

          <USelectMenu
            v-model="selectedFeedId"
            :items="attachOptions"
            value-key="value"
            searchable
            placeholder="搜索并选择订阅源"
            class="w-full"
          />

          <UAlert
            v-if="attachError"
            color="error"
            variant="soft"
            :title="attachError"
            class="mt-3"
          />

          <div
            v-if="attachOptions.length === 0"
            class="mt-3 text-sm text-muted"
          >
            没有可添加的订阅源，请先在侧边栏添加订阅。
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
            :disabled="!selectedFeedId"
            :loading="attachLoading"
            @click="addFeed"
          >
            添加
          </UButton>
        </template>
      </UModal>

      <!-- 删除机器人确认弹窗 -->
      <UModal
        v-model:open="deleteOpen"
        title="删除机器人"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <p class="text-sm">
            确定要删除
            <span class="font-semibold">@{{ bot?.preferredUsername }}</span>
            吗？关联的订阅源、出站记录与关注关系将一并删除，此操作不可撤销。
          </p>
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
            :loading="deleting"
            @click="deleteBot"
          >
            删除
          </UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
