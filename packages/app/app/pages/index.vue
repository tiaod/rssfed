<script setup lang="ts">
import { useUserStore } from "~/stores/user"

const userStore = useUserStore()
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="主页">
        <template #right>
          <UButton
            v-if="!userStore.user"
            to="/login"
            variant="subtle"
            color="primary"
            size="sm"
          >
            登录
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="userStore.user">
        <h1 class="text-2xl font-bold mb-2">
          欢迎回来，{{ userStore.user.name ?? userStore.user.email }}
        </h1>
        <p class="text-muted mb-6">
          你的 RSS 订阅和 ActivityPub 机器人面板
        </p>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <span class="i-lucide-rss text-lg" />
                <span class="font-semibold">订阅</span>
              </div>
            </template>
            <p class="text-sm text-muted">管理和发现新的 RSS 订阅源。</p>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <span class="i-lucide-bot text-lg" />
                <span class="font-semibold">机器人</span>
              </div>
            </template>
            <p class="text-sm text-muted">配置 ActivityPub 自动转发机器人。</p>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <span class="i-lucide-library text-lg" />
                <span class="font-semibold">已读</span>
              </div>
            </template>
            <p class="text-sm text-muted">离线阅读和收藏管理。</p>
          </UCard>
        </div>
      </div>

      <div v-else class="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <h1 class="text-3xl font-bold">RSSFed</h1>
        <p class="text-muted text-lg">
          支持 ActivityPub 的 RSS 阅读器
        </p>
        <UButton to="/login" color="primary" size="lg">
          开始使用
        </UButton>
      </div>
    </template>
  </UDashboardPanel>
</template>
