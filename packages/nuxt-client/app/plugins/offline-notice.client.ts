/**
 * 离线状态提示：断网时弹一条常驻提示，恢复联网后自动收起。
 *
 * 数据本身来自本地 PouchDB，界面上不会有明显异常，
 * 所以需要主动告诉用户「看到的是本机内容、操作会在联网后同步」。
 */
export default defineNuxtPlugin((nuxtApp) => {
  let offlineToastId: string | number | null = null

  // UApp 挂载后 useToast 才可用，因此把首次检查与监听都放在 app:mounted
  nuxtApp.hook('app:mounted', () => {
    function show() {
      if (offlineToastId !== null) return
      // add() 返回的是 Toast 对象，取 id 供 remove() 使用
      offlineToastId = useToast().add({
        title: '离线模式',
        description: '正在显示本机已同步的内容，联网后会自动同步',
        icon: 'i-lucide-wifi-off',
        color: 'warning',
        duration: 0
      }).id
    }

    function hide() {
      if (offlineToastId === null) return
      useToast().remove(offlineToastId)
      offlineToastId = null
    }

    if (!navigator.onLine) show()
    window.addEventListener('offline', show)
    window.addEventListener('online', hide)
  })
})
