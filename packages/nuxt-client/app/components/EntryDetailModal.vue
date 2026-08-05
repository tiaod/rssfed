<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'

const { isOpen, currentEntry, closeEntry } = useEntryModal()
const { settings } = useSettings()

// 小屏设备（手机）使用全屏模态，大屏使用设置中选择的宽度
const isSmallScreen = ref(false)
let mql: MediaQueryList | null = null
const update = () => { isSmallScreen.value = mql!.matches }

if (import.meta.client) {
  mql = window.matchMedia('(max-width: 767px)')
  update()
  mql.addEventListener('change', update)
}

onBeforeUnmount(() => {
  if (mql) {
    mql.removeEventListener('change', update)
  }
})
</script>

<template>
  <UModal
    v-model:open="isOpen"
    :title="currentEntry?.title"
    :fullscreen="isSmallScreen"
    :size="isSmallScreen ? undefined : settings.entryModalSize"
    scrollable
  >
    <template #body>
      <EntryDetail
        v-if="currentEntry"
        :entry="currentEntry"
      />
    </template>

    <template #footer>
      <div class="flex justify-end">
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          @click="closeEntry"
        >
          关闭
        </UButton>
      </div>
    </template>
  </UModal>
</template>
