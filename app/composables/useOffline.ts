import { ref, computed, onMounted, onUnmounted } from 'vue'

export function useOffline() {
  const isOnline = ref(true)
  const isOffline = computed(() => !isOnline.value)

  function onOnline() {
    isOnline.value = true
  }

  function onOffline() {
    isOnline.value = false
  }

  onMounted(() => {
    isOnline.value = navigator.onLine
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  })

  onUnmounted(() => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
  })

  return {
    isOnline,
    isOffline
  }
}
