/**
 * 注册 Service Worker（见 public/sw.js），让站点在断网后仍能打开。
 *
 * 只做两件事：注册、以及在检测到新版本时提示用户刷新。
 * 不自动 skipWaiting —— 新版 SW 一激活就会清掉旧缓存，若此时页面还在用旧 chunk 会直接白屏。
 */
export default defineNuxtPlugin(() => {
  // 开发环境不注册：缓存优先策略会挡住 Vite 的 HMR 与热更新请求
  if (import.meta.dev) return
  if (!('serviceWorker' in navigator)) return

  /** 只有用户点击「刷新」后才重载，避免首次安装 claim 时白刷一次 */
  let updateRequested = false

  function promptUpdate(registration: ServiceWorkerRegistration) {
    const toast = useToast()
    toast.add({
      title: '有新版本可用',
      description: '刷新页面即可使用最新版本',
      duration: 0,
      actions: [{
        label: '刷新',
        onClick: () => {
          updateRequested = true
          registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
        }
      }]
    })
  }

  function register() {
    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      // 上次访问时下载好、但还没激活的更新
      if (registration.waiting && navigator.serviceWorker.controller) {
        promptUpdate(registration)
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          // controller 存在说明是更新而非首次安装（首次安装直接接管即可，无需打扰用户）
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            promptUpdate(registration)
          }
        })
      })
    }).catch((error) => {
      console.warn('[SW] 注册失败，离线能力不可用', error)
    })
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) window.location.reload()
  })

  // 等首屏资源加载完再装 SW，避免 1.7MB 预缓存和首屏抢带宽
  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register, { once: true })
  }
})
