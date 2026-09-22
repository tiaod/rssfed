<script setup lang="ts">
definePageMeta({
  layout: 'default'
})

interface PublicBot {
  id: string
  name: string
  preferredUsername: string
  description?: string
  avatarUrl?: string
  isActive: boolean
}

const api = useApi()
const pouch = usePouchDb()
const toast = useToast()
const bots = ref<PublicBot[]>([])
const subscribed = ref<Set<string>>(new Set())
const loading = ref(true)
const error = ref<string | null>(null)

// 从 API 地址推导 Bot 的联邦宇宙域名（仅用于展示 handle）
const apiHost = (useRuntimeConfig().public.apiBaseUrl ?? 'http://localhost:3001').replace(/^https?:\/\//, '')

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

/** 读取本地订阅列表中的 bot 订阅（离线可用），得到已订阅 botId 集合 */
async function loadSubscribed() {
  const subs = await pouch.listSubscriptions()
  subscribed.value = new Set(
    subs.filter(s => s.kind === 'bot').map(s => s.id.slice('bot:'.length))
  )
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const [list] = await Promise.all([api.bots.public(), loadSubscribed()])
    bots.value = list.filter(b => b.isActive)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function toggleSubscribe(bot: PublicBot) {
  try {
    if (subscribed.value.has(bot.id)) {
      await pouch.removeSubscription(`bot:${bot.id}`)
      subscribed.value.delete(bot.id)
      toast.add({ title: '已取消订阅', description: bot.name, color: 'neutral' })
    } else {
      await pouch.addBotSubscription(bot.id, {
        title: bot.name,
        description: bot.description,
        image: bot.avatarUrl,
      })
      // 订阅后立即触发产出库复制，马上能看到产出
      pouch.syncFeed(`bot:${bot.id}`)
      subscribed.value.add(bot.id)
      toast.add({ title: '订阅成功', description: bot.name, color: 'success' })
    }
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  }
}

function botHandle(bot: PublicBot): string {
  return `@${bot.preferredUsername}@${apiHost}`
}

onMounted(load)
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Bot 广场">
        <template #right>
          <UButton
            icon="i-lucide-settings"
            variant="ghost"
            color="neutral"
            size="sm"
            :to="'/bots'"
          >
            管理我的机器人
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

      <div
        v-else-if="loading"
        class="flex justify-center py-12"
      >
        <ULoading />
      </div>

      <div
        v-else-if="!bots.length"
        class="flex flex-col items-center py-12 gap-4"
      >
        <UIcon
          name="i-lucide-bot"
          class="size-12 text-muted"
        />
        <p class="text-muted">
          还没有可订阅的机器人，去创建一个吧
        </p>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          :to="'/bots'"
        >
          创建机器人
        </UButton>
      </div>

      <div
        v-else
        class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <UCard
          v-for="bot in bots"
          :key="bot.id"
        >
          <template #header>
            <div class="flex items-center gap-3">
              <UAvatar
                v-if="bot.avatarUrl"
                :src="bot.avatarUrl"
                :alt="bot.name"
                size="lg"
              />
              <UAvatar
                v-else
                :text="bot.name?.[0] ?? 'B'"
                size="lg"
                color="primary"
              />
              <div class="min-w-0">
                <h2 class="font-bold truncate">
                  {{ bot.name }}
                </h2>
                <p class="text-xs text-muted truncate">
                  {{ botHandle(bot) }}
                </p>
              </div>
            </div>
          </template>

          <p
            v-if="bot.description"
            class="text-sm text-muted line-clamp-2"
          >
            {{ bot.description }}
          </p>

          <template #footer>
            <div class="flex items-center justify-between gap-2">
              <UButton
                variant="outline"
                color="neutral"
                size="xs"
                icon="i-lucide-newspaper"
                :to="`/bots/${bot.id}/posts?name=${encodeURIComponent(bot.name)}`"
              >
                查看产出
              </UButton>
              <UButton
                size="xs"
                :color="subscribed.has(bot.id) ? 'neutral' : 'primary'"
                :variant="subscribed.has(bot.id) ? 'outline' : 'solid'"
                :icon="subscribed.has(bot.id) ? 'i-lucide-bell-off' : 'i-lucide-bell-plus'"
                @click="toggleSubscribe(bot)"
              >
                {{ subscribed.has(bot.id) ? '已订阅' : '订阅' }}
              </UButton>
            </div>
          </template>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
