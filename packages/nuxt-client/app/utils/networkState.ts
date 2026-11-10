/**
 * 浏览器网络状态的判据与「恢复联网」事件（纯函数 + 模块级一次注册）。
 *
 * 为什么单独抽一份：离线短路在两个地方都要用 —— `useCouchTargets`（取库名，决定要不要发请求）
 * 与 `usePouchDb`（挂 live 复制、等优先同步，决定要不要继续等）。两处对「不知道」的处理必须一致，
 * 否则会出现「一处认为离线、另一处还在等满 5 秒」这种最糟的组合。
 *
 * `navigator.onLine` 只在**明确为 false** 时才算离线：字段缺失或为 undefined（SSR、老浏览器、
 * 测试桩）不能当成断网 —— 那会让同步在拿不到该字段的环境里永远不启动。
 */
export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** 「恢复联网」的订阅者（模块级一份，`online` 事件只绑一次） */
const onlineListeners = new Set<() => void>()
let onlineBound = false

/**
 * 订阅「浏览器恢复联网」。
 *
 * 恢复联网是**必须**清掉各种退避的时刻：用户明明已经连上了还要等退避窗口走完，
 * 界面看起来就是「同步坏了」，而这恰恰是用户最关注它的时刻（刚断网又恢复）。
 * 这里不用轮询 `navigator.onLine`：`online` 事件是浏览器给出的、最可靠的「现在通了」信号。
 */
export function onBrowserOnline(listener: () => void): void {
  onlineListeners.add(listener)
  // 只在真的挂上监听之后才记「已注册」：SSR 阶段（没有 window）不挂，浏览器端才能补挂
  if (onlineBound || typeof window === 'undefined') return
  onlineBound = true
  window.addEventListener('online', () => {
    for (const fn of onlineListeners) {
      try {
        fn()
      } catch {
        // 单个订阅者出错不影响其它订阅者（退避清理是尽力而为的）
      }
    }
  })
}
