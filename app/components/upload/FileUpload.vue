<template>
  <UCard>
    <UFileInput
      v-model="selectedFile"
      name="file"
      :accept="accept"
      :disabled="uploading"
      @change="handleUpload"
    >
      <template #trigger>
        <UButton
          :disabled="uploading"
          icon="i-lucide-upload"
        >
          {{ uploading ? '上传中...' : '选择文件' }}
        </UButton>
      </template>
    </UFileInput>

    <div
      v-if="uploadedFile"
      class="mt-4"
    >
      <UAlert color="success">
        <div class="flex items-center gap-2">
          <p>上传成功</p>
          <ULink
            v-if="fileUrl"
            :href="fileUrl"
            target="_blank"
            class="text-sm"
          >查看文件</ULink>
        </div>
      </UAlert>
    </div>

    <div
      v-if="error"
      class="mt-4"
    >
      <UAlert color="error">
        {{ error }}
      </UAlert>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { FileUploadResponse } from '~/types/file'

const selectedFile = ref<File | null>(null)
const uploading = ref(false)
const uploadedFile = ref<FileUploadResponse['file'] | null>(null)
const error = ref<string | null>(null)

const props = defineProps<{
  accept?: string
  title?: string
}>()

const emit = defineEmits<{
  success: [file: FileUploadResponse['file']]
  error: [err: Error]
}>()

const fileUrl = computed(() => {
  if (!uploadedFile.value) return null
  return `/api/files/${uploadedFile.value.id}`
})

async function handleUpload() {
  if (!selectedFile.value) return

  uploading.value = true
  error.value = null

  try {
    const formData = new FormData()
    formData.append('file', selectedFile.value)
    if (props.title) {
      formData.append('title', props.title)
    }

    const res = await $fetch<FileUploadResponse>('/api/files/upload', {
      method: 'POST',
      body: formData
    })

    uploadedFile.value = res.file
    emit('success', res.file)
  } catch (err) {
    const msg = err instanceof Error ? err.message : '上传失败'
    error.value = msg
    emit('error', err as Error)
  } finally {
    uploading.value = false
  }
}
</script>
