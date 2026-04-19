<script setup lang="ts">
interface Notification {
  id: number
  title: string
  description: string
  time: string
  read: boolean
}

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const props = defineProps<{
  open: boolean
}>()

const open = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

defineShortcuts({
  n: () => {
    open.value = !open.value
  }
})

const notifications = ref<Notification[]>([
  {
    id: 1,
    title: '欢迎使用 RSSFed',
    description: '开始添加你的第一个 RSS 订阅源吧',
    time: '刚刚',
    read: false
  }
])

const unreadCount = computed(() => {
  return notifications.value.filter(n => !n.read).length
})

const markAllAsRead = () => {
  notifications.value.forEach(n => n.read = true)
}

// 暴露未读数量给父组件
defineExpose({
  unreadCount
})
</script>

<template>
  <USlideover
      v-model:open="open"
      title="通知"
    >
      <template #body>
        <div class="space-y-2">
          <div
            v-for="notification in notifications"
            :key="notification.id"
            :class="[
              'p-3 rounded-lg transition-colors cursor-pointer',
              notification.read ? 'bg-transparent' : 'bg-muted/50'
            ]"
          >
            <div class="flex items-start justify-between gap-2">
              <p class="font-medium text-sm">
                {{ notification.title }}
              </p>
              <span class="text-xs text-muted whitespace-nowrap">
                {{ notification.time }}
              </span>
            </div>
            <p class="text-sm text-muted mt-1">
              {{ notification.description }}
            </p>
          </div>

          <p
            v-if="notifications.length === 0"
            class="text-center py-8 text-sm text-muted"
          >
            暂无通知
          </p>
        </div>
      </template>
      <template #footer>
        <UButton
          variant="ghost"
          color="neutral"
          block
          @click="markAllAsRead"
        >
          全部标为已读
        </UButton>
      </template>
  </USlideover>
</template>
