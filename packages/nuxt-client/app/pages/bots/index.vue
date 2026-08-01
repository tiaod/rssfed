<script setup lang="ts">
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

const api = useApi()
const bots = ref<BotInfo[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// 从 API 地址推导 Bot 的联邦宇宙域名（仅用于展示 handle）
const apiHost = (useRuntimeConfig().public.apiBaseUrl ?? 'http://localhost:3001').replace(/^https?:\/\//, '')

onMounted(async () => {
  try {
    bots.value = await api.bots.list()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
})

function botHandle(bot: BotInfo): string {
  return `@${bot.preferredUsername}@${apiHost}`
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="机器人" />
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
          还没有机器人，先在服务端创建吧
        </p>
      </div>

      <div
        v-else
        class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <UCard
          v-for="bot in bots"
          :key="bot.id"
          class="cursor-pointer transition-shadow hover:shadow-md"
          :to="`/bots/${bot.id}`"
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
            <div class="flex items-center justify-between text-xs">
              <span :class="bot.isActive ? 'text-green-600' : 'text-red-500'">
                {{ bot.isActive ? '运行中' : '已停用' }}
              </span>
              <UButton
                variant="outline"
                color="neutral"
                size="xs"
                :to="`/bots/${bot.id}`"
              >
                查看动态
              </UButton>
            </div>
          </template>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
