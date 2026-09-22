<script setup lang="ts">
import type { BotInfo } from '~/types/bot'

definePageMeta({
  layout: 'default'
})

const api = useApi()
const toast = useToast()
const bots = ref<BotInfo[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// 从 API 地址推导 Bot 的联邦宇宙域名（仅用于展示 handle）
const apiHost = (useRuntimeConfig().public.apiBaseUrl ?? 'http://localhost:3001').replace(/^https?:\/\//, '')

// ── 创建机器人 ──
const createOpen = ref(false)
const creating = ref(false)
const formError = ref<string | null>(null)
const form = ref({
  name: '',
  preferredUsername: '',
  description: '',
  avatarUrl: ''
})

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

async function loadBots() {
  loading.value = true
  error.value = null
  try {
    bots.value = await api.bots.list()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function createBot() {
  const name = form.value.name.trim()
  const username = form.value.preferredUsername.trim()
  if (!name || !username) {
    formError.value = '名称和用户名不能为空'
    return
  }
  // ActivityPub 用户名仅允许字母、数字与下划线
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    formError.value = '用户名只能包含字母、数字和下划线'
    return
  }

  creating.value = true
  formError.value = null
  try {
    await api.bots.create({
      name,
      preferredUsername: username,
      description: form.value.description.trim() || undefined,
      avatarUrl: form.value.avatarUrl.trim() || undefined
    })
    toast.add({ title: '机器人创建成功', description: `@${username}`, color: 'success' })
    createOpen.value = false
    form.value = { name: '', preferredUsername: '', description: '', avatarUrl: '' }
    await loadBots()
  } catch (e) {
    formError.value = errorMessage(e)
  } finally {
    creating.value = false
  }
}

onMounted(loadBots)

function botHandle(bot: BotInfo): string {
  return `@${bot.preferredUsername}@${apiHost}`
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="机器人">
        <template #right>
          <UButton
            icon="i-lucide-plus"
            color="primary"
            size="sm"
            @click="createOpen = true"
          >
            创建机器人
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
        <UIcon
          name="i-lucide-loader-circle"
          class="size-8 animate-spin text-muted"
        />
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
          还没有机器人，创建第一个来自动转发你的订阅吧
        </p>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          @click="createOpen = true"
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
                管理
              </UButton>
            </div>
          </template>
        </UCard>
      </div>

      <!-- 创建机器人弹窗 -->
      <UModal
        v-model:open="createOpen"
        title="创建机器人"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <UForm
            :state="form"
            class="space-y-4"
            @submit="createBot"
          >
            <UFormField
              label="名称"
              required
            >
              <UInput
                v-model="form.name"
                placeholder="如：科技早报"
                class="w-full"
              />
            </UFormField>

            <UFormField
              label="用户名"
              required
            >
              <UInput
                v-model="form.preferredUsername"
                placeholder="如：tech_daily（将显示为 @tech_daily@你的域名）"
                class="w-full"
              />
            </UFormField>

            <UFormField label="简介">
              <UTextarea
                v-model="form.description"
                placeholder="机器人介绍，会显示在 ActivityPub 主页"
                class="w-full"
                :rows="3"
              />
            </UFormField>

            <UFormField label="头像 URL">
              <UInput
                v-model="form.avatarUrl"
                placeholder="https://example.com/avatar.png"
                class="w-full"
              />
            </UFormField>

            <UAlert
              v-if="formError"
              color="error"
              variant="soft"
              :title="formError"
              icon="i-lucide-circle-alert"
            />
          </UForm>
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
            :loading="creating"
            @click="createBot"
          >
            创建
          </UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
