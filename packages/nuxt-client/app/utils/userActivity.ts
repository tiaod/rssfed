/**
 * 「用户此刻是不是在跟界面打交道」的判据（模块级一份，事件只绑一次）。
 *
 * 为什么需要它：本地库的空闲维护（追平视图索引、裁剪、压缩）都是纯消耗的活，全库扫一遍
 * 在几百 MB 的库上是实打实的 IO/CPU。同步刚安静下来就动手，撞上的往往正是用户回来翻列表
 * 的那几秒 —— 实测「压缩 + 冷索引查询」叠在一起能把一次「查看」从 7ms 拖到 2 秒。
 * 所以维护要挑用户已经停手的窗口，而不是只看同步是否空闲。
 *
 * 只记「最后一次操作的时间」，不做节流也不做防抖：安静多久才算空下来由调用方判断
 * （见 utils/localCompact 的 decideIdleRun），这里只负责如实记录。
 * scroll 也要算 —— 阅读类应用里「正在读」就是一直在滚，那是最典型的「别现在动手」。
 */
let lastActivityAt = 0

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

let bound = false

/** 记一次用户操作；不传时间就是此刻 */
export function markUserActivity(at: number = Date.now()): void {
  lastActivityAt = at
}

/** 用户最后一次操作的时间；从未记录过为 0（调用方据此判断「一直没人用」） */
export function lastUserActivityAt(): number {
  return lastActivityAt
}

/** 清掉记录：模块级状态会跨用例残留，单测每个用例都得从「从没操作过」起算 */
export function resetUserActivity(): void {
  lastActivityAt = 0
}

/** 页面在后台：没有用户在看，也就没有可让位的人 */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * 开始跟踪用户操作。
 *
 * 只在真要排空闲维护时才绑（见 usePouchDb 的 scheduleIdleMaintenance），不给首屏加活。
 * 监听器必须捕获阶段 + passive：滚动不冒泡，只有捕获能拿到滚动容器内部的滚动；而滚动
 * 每帧都在派发，监听器自己不能拖慢它。回调包一层箭头函数是硬要求 —— 直接把
 * markUserActivity 交给 addEventListener 会把 Event 当成时间戳存进去，
 * 之后 `now - lastActivityAt` 全是 NaN，维护就再也不会动手了。
 */
export function bindUserActivityTracking(): void {
  if (bound || typeof window === 'undefined') return
  bound = true
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, () => markUserActivity(), { passive: true, capture: true })
  }
}
