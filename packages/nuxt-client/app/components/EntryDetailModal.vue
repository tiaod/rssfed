<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'

const { isOpen, currentEntry, closeEntry } = useEntryModal()
const { settings } = useSettings()

// 小屏设备（手机）始终全屏；大屏按设置：选「全屏」档时也全屏
const isSmallScreen = ref(false)
const isFullscreen = computed(() => isSmallScreen.value || settings.value.entryModalSize === 'fullscreen')
// 非全屏（居中弹窗）或全屏但未固定顶/底栏时，整个模态随 overlay 滚动
const isScrollable = computed(() => !isFullscreen.value || !settings.value.fixedBars)

let mql: MediaQueryList | null = null
function onScreenChange(event: MediaQueryListEvent) {
  isSmallScreen.value = event.matches
}

// 浏览器返回键可关闭弹窗：
// 打开时压入一条历史记录，返回键触发 popstate 时关闭（浏览器已自动出栈）；
// 程序化关闭（关闭按钮/Esc/遮罩）时若该记录仍在栈顶则退掉，避免历史堆积
const HISTORY_KEY = '__entryModal'

function onPopState() {
  if (isOpen.value) {
    isOpen.value = false
  }
}

watch(isOpen, (open, wasOpen) => {
  if (!import.meta.client) return
  if (open) {
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: true }, '', window.location.href)
  } else if (wasOpen && window.history.state?.[HISTORY_KEY]) {
    window.history.go(-1)
  }
})

if (import.meta.client) {
  mql = window.matchMedia('(max-width: 767px)')
  isSmallScreen.value = mql.matches
  mql.addEventListener('change', onScreenChange)
  window.addEventListener('popstate', onPopState)
}

onBeforeUnmount(() => {
  mql?.removeEventListener('change', onScreenChange)
  if (import.meta.client) {
    window.removeEventListener('popstate', onPopState)
  }
})

// 标题过长时省略号截断，并预留右侧关闭按钮空间（各模式通用）
const TRUNCATE_UI = {
  wrapper: 'min-w-0 flex-1 pe-10',
  title: 'truncate',
}

// 全屏 + 固定顶/底栏：content 铺满视口，body 内部滚动、header/footer 固定
// 全屏 + 不固定：整个模态（含 header/footer）随 overlay 一起滚动，短内容至少铺满高度
// 非全屏：按设置的宽度控制
const modalUi = computed(() => {
  if (!isFullscreen.value) {
    return { content: settings.value.entryModalSize, ...TRUNCATE_UI }
  }
  if (settings.value.fixedBars) {
    return {
      content: 'h-dvh flex flex-col',
      header: 'relative shrink-0 min-h-12 py-2.5 px-4 sm:px-6',
      body: 'flex-1 min-h-0',
      footer: 'shrink-0 px-4 sm:px-6 py-2',
      close: 'top-1/2 -translate-y-1/2',
      ...TRUNCATE_UI,
    }
  }
  return { content: 'min-h-dvh flex flex-col', ...TRUNCATE_UI }
})
</script>

<template>
  <UModal
    v-model:open="isOpen"
    :title="currentEntry?.title"
    :fullscreen="isFullscreen"
    :scrollable="isScrollable"
    :ui="modalUi"
  >
    <template #body>
      <EntryDetail
        v-if="currentEntry"
        :entry="currentEntry"
      />
    </template>

    <template #footer>
      <div class="flex items-center justify-between gap-2">
        <UButton
          v-if="currentEntry"
          :to="currentEntry.url"
          target="_blank"
          label="阅读原文"
          icon="i-lucide-external-link"
          variant="outline"
          size="sm"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          size="sm"
          @click="closeEntry"
        >
          关闭
        </UButton>
      </div>
    </template>
  </UModal>
</template>
