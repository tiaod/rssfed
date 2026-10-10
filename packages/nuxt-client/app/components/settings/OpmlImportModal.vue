<script setup lang="ts">
import { ref, computed } from 'vue'
import type { OpmlImportEvent, OpmlImportProgress, OpmlImportResult } from '~/utils/opmlImport'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'imported'): void
}>()

const api = useApi()
const toast = useToast()

const importing = ref(false)
const error = ref<string | null>(null)
const result = ref<OpmlImportResult | null>(null)

// ── 输入方式：上传文件 / 粘贴内容 ──
// 这两项是「切换视图」而不是「执行动作」，所以用 UTabs：按钮会让人以为点下去就
// 开始上传/粘贴了。（UTabs 的 tab 值内部按字符串处理，mode 用普通字符串 ref。）
const mode = ref('file')
const selectedFile = ref<File | null>(null)
const pasted = ref('')
/** 导入期间连输入方式一起禁掉：请求已经发出去了，此时换标签/换文件都没有意义 */
const modeTabs = computed(() => [
  { label: '上传文件', value: 'file', icon: 'i-lucide-upload', disabled: importing.value },
  { label: '粘贴内容', value: 'paste', icon: 'i-lucide-clipboard-paste', disabled: importing.value }
])

/** 实时进度（start/progress 事件累积）；null 表示还在解析/准备阶段，进度条走不定态 */
const progress = ref<OpmlImportProgress | null>(null)
/** 本次导入的中止句柄：关掉弹窗即断开流，服务端会停下剩余的源 */
let abortController: AbortController | null = null

const openModel = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v)
})

const canSubmit = computed(() => {
  const content = mode.value === 'file'
    ? selectedFile.value?.name
    : pasted.value.trim()
  return Boolean(content) && !importing.value
})

/** 进度百分比（未拿到 total 前为 undefined，交给 UProgress 走不定态） */
const percent = computed(() => {
  if (!progress.value?.total) return undefined
  return Math.round(progress.value.done / progress.value.total * 100)
})

const progressText = computed(() => {
  const p = progress.value
  if (!p) return '正在读取 OPML 并准备导入…'
  const parts = [`已处理 ${p.done}/${p.total} 个源`]
  if (p.imported > 0) parts.push(`成功 ${p.imported}`)
  if (p.skipped > 0) parts.push(`跳过 ${p.skipped}`)
  if (p.failed > 0) parts.push(`失败 ${p.failed}`)
  return parts.join(' · ')
})

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  selectedFile.value = input.files?.[0] ?? null
}

function reset() {
  // 关窗即断开导入流（服务端会停下未开始的源），并清掉上一次的输入与结果
  abortController?.abort()
  abortController = null
  mode.value = 'file'
  selectedFile.value = null
  pasted.value = ''
  error.value = null
  result.value = null
  progress.value = null
}

/** 读取 OPML 内容并提交到后端（流式，逐源回报进度） */
async function submit() {
  error.value = null
  result.value = null
  progress.value = null

  let content = ''
  try {
    content = mode.value === 'file'
      ? (selectedFile.value ? await selectedFile.value.text() : '')
      : pasted.value
  } catch {
    error.value = '读取文件失败，请确认文件未损坏'
    return
  }
  const opml = content.trim()
  if (!opml) {
    error.value = 'OPML 内容为空，请检查文件或粘贴内容'
    return
  }

  importing.value = true
  // 记在局部：reset() 会把 abortController 置空，catch 里只能靠这个局部引用判断是不是被中止
  const controller = new AbortController()
  abortController = controller
  try {
    result.value = await api.feeds.importOpml(opml, {
      signal: controller.signal,
      onEvent: (event: OpmlImportEvent) => {
        if (event.type === 'start') {
          progress.value = { done: 0, total: event.total, imported: 0, skipped: 0, failed: 0, title: '' }
        } else if (event.type === 'progress') {
          progress.value = {
            done: event.done,
            total: event.total,
            imported: event.imported,
            skipped: event.skipped,
            failed: event.failed,
            title: event.title
          }
        }
      }
    })
    toast.add({
      title: 'OPML 导入完成',
      description: `成功 ${result.value.imported} 个，跳过 ${result.value.skipped} 个`,
      color: result.value.failed.length ? 'warning' : 'success'
    })
    emit('imported')
  } catch (e) {
    // 关掉弹窗触发的中止不算失败：已导入的订阅保留，也不必弹错误
    if (controller.signal.aborted) return
    const err = e as { data?: { error?: string }, message?: string }
    error.value = err.data?.error ?? err.message ?? '导入失败'
  } finally {
    importing.value = false
    if (abortController === controller) abortController = null
  }
}

const summaryTitle = computed(() => {
  if (!result.value) return ''
  const parts = [`成功导入 ${result.value.imported} 个`]
  if (result.value.skipped > 0) parts.push(`跳过 ${result.value.skipped} 个（已订阅）`)
  if (result.value.failed.length > 0) parts.push(`失败 ${result.value.failed.length} 个`)
  return parts.join('，')
})
</script>

<template>
  <!-- 关闭动画结束才重置：事件名必须带冒号（UModal 抛的是 after:leave，写成 @after-leave 收不到，
       同 EntryDetailModal 的 @after:enter）。reset 里顺带断开还在跑的导入流。 -->
  <UModal
    v-model:open="openModel"
    title="导入 OPML"
    :ui="{ footer: 'justify-end' }"
    :dismissible="!importing"
    :close="importing ? { disabled: true } : true"
    @after:leave="reset"
  >
    <template #body>
      <p class="text-sm text-muted mb-4">
        从 OPML 文件批量导入订阅源，将按文件中的分组结构自动归类。
      </p>

      <!-- 输入方式：切换标签，而不是两个会「执行」的按钮 -->
      <UTabs
        v-model="mode"
        :items="modeTabs"
        :content="false"
        size="sm"
        class="mb-4"
      />

      <!-- 文件上传（导入期间整块禁用：指针与键盘入口都拦住，input 本身也 disabled） -->
      <label
        v-if="mode === 'file'"
        class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-default px-4 py-8 transition-colors"
        :class="importing ? 'pointer-events-none opacity-75' : 'cursor-pointer hover:border-primary'"
        :aria-disabled="importing || undefined"
      >
        <input
          type="file"
          accept=".opml,.xml,text/xml,application/xml"
          class="hidden"
          :disabled="importing"
          @change="onFileChange"
        >
        <UIcon
          :name="selectedFile ? 'i-lucide-file-check' : 'i-lucide-file-up'"
          class="size-8"
          :class="selectedFile ? 'text-green-500' : 'text-muted'"
        />
        <p class="text-sm font-medium">
          {{ selectedFile?.name || '点击选择 OPML 文件' }}
        </p>
        <p class="text-xs text-muted">
          支持 .opml / .xml 格式
        </p>
      </label>

      <!-- 粘贴内容（UTextarea 根节点是 inline-flex，独立使用时必须显式 w-full 才占满宽度） -->
      <UTextarea
        v-else
        v-model="pasted"
        :rows="8"
        class="w-full"
        :disabled="importing"
        placeholder="粘贴 OPML 内容，例如 <opml version=&quot;2.0&quot;><body>…</body></opml>"
      />

      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        :title="error"
        icon="i-lucide-circle-alert"
        class="mt-3"
      />

      <!-- 导入进度：逐个源联网解析，几十上百个源要跑一会儿，这里给出实在的进度 -->
      <div
        v-if="importing"
        class="mt-4 space-y-2"
      >
        <UProgress
          :model-value="percent ?? null"
          :status="percent !== undefined"
          color="primary"
        />
        <p class="text-xs text-muted">
          {{ progressText }}
        </p>
        <p
          v-if="progress?.title"
          class="truncate text-xs text-muted"
        >
          {{ progress.title }}
        </p>
      </div>

      <!-- 导入结果 -->
      <div
        v-if="result"
        class="mt-4 space-y-3"
      >
        <UAlert
          :color="result.failed.length ? 'warning' : 'success'"
          variant="soft"
          :title="summaryTitle"
          :icon="result.failed.length ? 'i-lucide-triangle-alert' : 'i-lucide-check-circle'"
        />
        <div
          v-if="result.failed.length"
          class="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-default p-3"
        >
          <div
            v-for="f in result.failed"
            :key="f.url"
            class="space-y-0.5"
          >
            <p class="break-all text-xs font-medium">
              {{ f.url }}
            </p>
            <p class="text-xs text-muted">
              {{ f.error }}
            </p>
          </div>
        </div>
      </div>
    </template>

    <template #footer="{ close }">
      <UButton
        variant="outline"
        color="neutral"
        @click="close"
      >
        {{ importing ? '取消导入' : (result ? '完成' : '取消') }}
      </UButton>
      <UButton
        v-if="!result"
        color="primary"
        icon="i-lucide-download"
        :loading="importing"
        :disabled="!canSubmit"
        @click="submit"
      >
        开始导入
      </UButton>
    </template>
  </UModal>
</template>
