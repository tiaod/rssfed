<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useClipboard } from '@vueuse/core'
import { LIST_VIEW_OPTIONS, type ListView } from '~/utils/listViews'

/**
 * 弹窗只用这几个字段，所以不绑定完整的 FeedSubscriptionItem：
 * 订阅管理页给它注册表拉来的完整对象，单源页 / bot 产出页则从本地订阅文档拼最小集。
 */
export interface EditableSubscription {
  feedId: string
  title?: string
  category?: string
  /** 该订阅源的默认视图（未设置为 undefined = 跟随分组 / 全局） */
  view?: ListView
  /**
   * 订阅源地址，**只读展示**：RSS/Atom 订阅是抓取地址（FeedDoc / 注册表），
   * bot 订阅没有 RSS 地址，这里放它的联邦地址 `@用户名@域名`（见 utils/botHandle）。
   * 取不到时（离线且本地没有 FeedDoc）不渲染这一行。
   */
  feedUrl?: string
}

const props = defineProps<{ subscription: EditableSubscription | null }>()
const emit = defineEmits<{
  close: []
  saved: [item: EditableSubscription]
}>()

const pouch = usePouchDb()
const toast = useToast()

/**
 * 地址是禁用输入框（改地址只能取消订阅后重新添加），复制按钮嵌在输入框内部 —— 单行框装不下
 * 长地址，手选又选不中，复制按钮是唯一的复制入口（Nuxt UI 的 #trailing 用法，
 * 见 https://ui.nuxt.com/docs/components/input#with-copy-button）。
 *
 * 复制成功的反馈做在按钮自己身上：图标换成 √ 并转成 success 色，两秒后收回
 * （useClipboard 的 copied 自带计时），不弹右下角通知 —— 只是顺手复制一下，
 * 弹通知比操作本身还重。
 */
const { copy, copied } = useClipboard({ legacy: true, copiedDuring: 2000 })

async function copyFeedUrl() {
  const url = props.subscription?.feedUrl
  if (url) await copy(url)
}

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

        <!--
          订阅源地址：禁用输入框（灰底灰字，一看就不能改），地址本身由订阅时确定 ——
          改地址只能取消订阅后重新添加（后端是按地址建抓取任务的）。
          复制按钮走 Nuxt UI 官方的 #trailing 用法；trailing 让输入框右侧留出按钮的位置，
          输入框自身再挂 title，长地址被截断时悬停仍能看全。
        -->
        <UFormField
          v-if="subscription?.feedUrl"
          label="订阅源地址"
          description="由订阅时确定，不可修改"
        >
          <UInput
            :model-value="subscription.feedUrl"
            disabled
            trailing
            class="w-full"
            :title="subscription.feedUrl"
            :ui="{ trailing: 'pe-0.5' }"
          >
            <template #trailing>
              <UTooltip
                text="复制订阅源地址"
                :content="{ side: 'right' }"
              >
                <UButton
                  :color="copied ? 'success' : 'neutral'"
                  variant="link"
                  size="sm"
                  :icon="copied ? 'i-lucide-copy-check' : 'i-lucide-copy'"
                  :aria-label="copied ? '已复制订阅源地址' : '复制订阅源地址'"
                  @click="copyFeedUrl"
                />
              </UTooltip>
            </template>
          </UInput>
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
