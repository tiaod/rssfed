<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'imported'): void
}>()

const api = useApi()
const toast = useToast()

interface ImportResult {
  total: number
  imported: number
  skipped: number
  failed: { url: string, error: string }[]
}

// ── 输入方式：上传文件 / 粘贴内容 ──
const mode = ref<'file' | 'paste'>('file')
const selectedFile = ref<File | null>(null)
const pasted = ref('')

const importing = ref(false)
const error = ref<string | null>(null)
const result = ref<ImportResult | null>(null)

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

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  selectedFile.value = input.files?.[0] ?? null
}

function reset() {
  mode.value = 'file'
  selectedFile.value = null
  pasted.value = ''
  error.value = null
  result.value = null
}

/** 读取 OPML 内容并提交到后端 */
async function submit() {
  error.value = null
  result.value = null

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
  try {
    result.value = await api.feeds.importOpml(opml)
    toast.add({
      title: 'OPML 导入完成',
      description: `成功 ${result.value.imported} 个，跳过 ${result.value.skipped} 个`,
      color: result.value.failed.length ? 'warning' : 'success'
    })
    emit('imported')
  } catch (e) {
    const err = e as { data?: { error?: string }, message?: string }
    error.value = err.data?.error ?? err.message ?? '导入失败'
  } finally {
    importing.value = false
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
  <UModal
    v-model:open="openModel"
    title="导入 OPML"
    :ui="{ footer: 'justify-end' }"
    @after-leave="reset"
  >
    <template #body>
      <p class="text-sm text-muted mb-4">
        从 OPML 文件批量导入订阅源，将按文件中的分组结构自动归类。
      </p>

      <!-- 输入方式切换 -->
      <div class="grid grid-cols-2 gap-2 mb-4">
        <UButton
          :variant="mode === 'file' ? 'solid' : 'outline'"
          color="neutral"
          icon="i-lucide-upload"
          :block="true"
          @click="mode = 'file'"
        >
          上传文件
        </UButton>
        <UButton
          :variant="mode === 'paste' ? 'solid' : 'outline'"
          color="neutral"
          icon="i-lucide-clipboard-paste"
          :block="true"
          @click="mode = 'paste'"
        >
          粘贴内容
        </UButton>
      </div>

      <!-- 文件上传 -->
      <label
        v-if="mode === 'file'"
        class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-default px-4 py-8 cursor-pointer transition-colors hover:border-primary"
      >
        <input
          type="file"
          accept=".opml,.xml,text/xml,application/xml"
          class="hidden"
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

      <!-- 粘贴内容 -->
      <UTextarea
        v-else
        v-model="pasted"
        :rows="8"
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
        {{ result ? '完成' : '取消' }}
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
