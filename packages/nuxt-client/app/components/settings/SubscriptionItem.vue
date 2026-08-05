<script setup lang="ts">
import type { FeedSubscriptionItem, FeedStatus } from '~/types/rss'

const props = defineProps<{ subscription: FeedSubscriptionItem }>()
const emit = defineEmits<{
  remove: []
  edit: []
}>()

const statusMeta: Record<FeedStatus, { label: string, color: 'success' | 'neutral' | 'error', icon: string }> = {
  active: { label: '活跃', color: 'success', icon: 'i-lucide-circle-check' },
  paused: { label: '已暂停', color: 'neutral', icon: 'i-lucide-circle-pause' },
  error: { label: '错误', color: 'error', icon: 'i-lucide-circle-alert' }
}

const expandError = ref(false)

/** 相对时间显示（中文） */
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

/** 按错误特征给出解决建议 */
function suggestion(msg?: string): string {
  if (!msg) return '抓取失败，请稍后重试'
  if (/ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|timeout|timed out/i.test(msg)) {
    return '目标站点网络不可达（可能是被墙或服务异常）。请检查服务器网络或抓取代理（HTTPS_PROXY）配置，或稍后重试。'
  }
  if (/ENOTFOUND/i.test(msg)) return '域名无法解析，请检查订阅地址是否正确。'
  if (/404|410/i.test(msg)) return '订阅源已失效（404/410），请确认地址或寻找替代源。'
  if (/Failed to parse|not recognized|AggregateError/i.test(msg)) return '响应内容不是有效的 RSS/Atom 格式。'
  return '抓取失败。若持续发生，请检查订阅地址或联系站点管理员。'
}
</script>

<template>
  <UCard
    :ui="subscription.status === 'error' ? { root: 'border-red-500/60' } : {}"
  >
    <div class="flex items-start gap-3">
      <!-- 图标 -->
      <UAvatar
        v-if="subscription.image"
        :src="subscription.image"
        :alt="subscription.title"
        size="lg"
      />
      <UAvatar
        v-else
        :text="subscription.title?.[0] ?? 'R'"
        size="lg"
        :color="subscription.status === 'error' ? 'error' : 'primary'"
      />

      <!-- 信息区 -->
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-bold truncate">
            {{ subscription.title }}
          </h3>
          <UBadge
            :color="statusMeta[subscription.status].color"
            variant="subtle"
            size="xs"
          >
            <template #leading>
              <UIcon
                :name="statusMeta[subscription.status].icon"
                class="size-3"
              />
            </template>
            {{ statusMeta[subscription.status].label }}
          </UBadge>
          <UBadge
            v-if="subscription.category"
            variant="outline"
            size="xs"
            color="neutral"
          >
            {{ subscription.category }}
          </UBadge>
        </div>
        <p class="text-xs text-muted truncate">
          {{ subscription.siteUrl || '无站点链接' }}
        </p>
        <p class="text-xs text-muted">
          最近抓取：{{ timeAgo(subscription.lastFetchedAt) }}
        </p>
      </div>

      <!-- 用户操作按钮区：编辑 + 取消订阅 -->
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
        <UButton
          icon="i-lucide-pencil"
          size="xs"
          variant="ghost"
          color="neutral"
          aria-label="编辑"
          @click="$emit('edit')"
        />
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          variant="ghost"
          color="error"
          aria-label="取消订阅"
          @click="$emit('remove')"
        />
      </div>
    </div>

    <!-- 错误状态：只读展示详情 + 建议 -->
    <div
      v-if="subscription.status === 'error'"
      class="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2"
    >
      <button
        class="flex items-center gap-1.5 text-xs font-medium text-red-600"
        @click="expandError = !expandError"
      >
        <UIcon
          :name="expandError ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3.5"
        />
        错误详情
      </button>
      <Transition name="expand">
        <div
          v-if="expandError"
          class="mt-2 space-y-2"
        >
          <p class="break-all text-xs text-red-600/90">
            {{ subscription.errorMessage }}
          </p>
          <div class="flex gap-1.5 text-xs text-muted">
            <UIcon
              name="i-lucide-lightbulb"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span>{{ suggestion(subscription.errorMessage) }}</span>
          </div>
        </div>
      </Transition>
    </div>
  </UCard>
</template>

<style scoped>
/* 错误详情展开动画 */
.expand-enter-active,
.expand-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
