<script setup lang="ts">
import type { FeedSubscriptionItem } from '~/types/rss'

const props = defineProps<{ subscription: FeedSubscriptionItem | null }>()
const emit = defineEmits<{
  close: []
  saved: [item: FeedSubscriptionItem]
}>()

const pouch = usePouchDb()
const toast = useToast()

const open = computed({
  get: () => props.subscription !== null,
  set: (v: boolean) => { if (!v) emit('close') }
})

const form = ref({ title: '', category: '' })
const saving = ref(false)
const formError = ref<string | null>(null)

// 弹窗打开时初始化表单
watch(() => props.subscription, (sub) => {
  if (sub) {
    form.value = { title: sub.title ?? '', category: sub.category ?? '' }
    formError.value = null
  }
}, { immediate: true })

async function save() {
  if (!props.subscription) return
  saving.value = true
  formError.value = null
  try {
    await pouch.updateSubscription(props.subscription.feedId, {
      title: form.value.title.trim() || undefined,
      category: form.value.category.trim() || undefined
    })
    toast.add({ title: '已保存', description: props.subscription.title, color: 'success' })
    emit('saved', props.subscription)
  } catch (e) {
    const err = e as { message?: string }
    formError.value = err.message ?? '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="编辑订阅"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <UForm
        class="space-y-4"
        @submit="save"
      >
        <UFormField label="显示名称">
          <UInput
            v-model="form.title"
            placeholder="订阅显示名称"
            class="w-full"
          />
        </UFormField>

        <UFormField label="分类">
          <UInput
            v-model="form.category"
            placeholder="如：技术 / 新闻（留空则不分类）"
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
        :loading="saving"
        @click="save"
      >
        保存
      </UButton>
    </template>
  </UModal>
</template>
