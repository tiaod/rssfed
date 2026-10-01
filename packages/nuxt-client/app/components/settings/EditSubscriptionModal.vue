<script setup lang="ts">
import type { FeedSubscriptionItem } from '~/types/rss'
import { LIST_VIEW_OPTIONS, type ListView } from '~/utils/listViews'

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

/**
 * 「跟随上级」用一个哨兵值，不能用空串。
 *
 * reka 的 Select 明确禁止选项值为空串（空串被它当作「清空选择」：
 * `A <SelectItem /> must have a value prop that is not an empty string`），
 * 传了空串整个下拉都打不开。保存时再把哨兵值翻译成 null（删掉文档里的 view 字段）。
 */
const INHERIT_VIEW = '__inherit__'

type ViewChoice = ListView | typeof INHERIT_VIEW

const viewOptions = [
  { label: '跟随分组 / 全局默认', value: INHERIT_VIEW },
  ...LIST_VIEW_OPTIONS
]

const form = ref<{ title: string, category: string, view: ViewChoice }>({
  title: '',
  category: '',
  view: INHERIT_VIEW
})
const saving = ref(false)
const formError = ref<string | null>(null)

// 弹窗打开时初始化表单
watch(() => props.subscription, (sub) => {
  if (sub) {
    form.value = {
      title: sub.title ?? '',
      category: sub.category ?? '',
      view: sub.view ?? INHERIT_VIEW
    }
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
      category: form.value.category.trim() || undefined,
      // null 是「清除该订阅源的默认视图」：页面回退到分组 / 全局默认
      view: form.value.view === INHERIT_VIEW ? null : form.value.view
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

        <UFormField
          label="默认视图"
          description="打开这个订阅源时用哪种版式；「跟随」会依次取分组默认、全局默认"
        >
          <USelect
            v-model="form.view"
            :items="viewOptions"
            value-key="value"
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
