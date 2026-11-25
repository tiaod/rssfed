import { errorMessage } from '~/utils/errorMessage'
import { appendBackgroundSyncEvent } from '~/utils/backgroundSyncLog'
import { isBrowserOffline, notifyNetworkRecovered } from '~/utils/networkState'

/**
 * Background Sync：断网期间登记一次，浏览器恢复联网后在后台把 SW 唤醒（见 public/sw.js）。
 *
 * 这里**故意**只让 SW 催服务端聚合（`POST /api/timeline/refresh`），不在 SW 里跑 PouchDB 复制。
 * 不是因为做不到 —— PouchDB 的 idb/http 适配器在 SW 里能跑（它不碰 window/document，
 * http 适配器用的是 fetch + `credentials: 'include'`）。是下面三条代价：
 *
 *   1. **写进去了，页面也不知道**。IndexedDB 的变更不会跨上下文冒泡：PouchDB 的 changes
 *      靠 localStorage 的 `storage` 事件唤醒，而那个事件不投递给 Service Worker。
 *      于是 SW 复制完，开着的页面既不刷新列表、也不更新「已同步 N 条」，用户看到的是
 *      「网络回来了但内容还是旧的」，直到手动刷新。要修就得自己搭一条 BroadcastChannel
 *      通知链，让页面重新 allDocs —— 那是另一个功能的工作量；
 *   2. **两个上下文会同时复制同一个库**。SW 醒来时页面往往也正开着，两边各挂一条 live 复制、
 *      各写各的 checkpoint（`_local/<md5>`）。PouchDB 内部没有跨上下文互斥，只有
 *      「checkpoint PUT 撞了重试」，冲突分支的风险和重复下载都落在用户身上；
 *   3. **sync 事件不保证跑完**。浏览器给它几十秒、且可随时掐断。分批 checkpoint 确实让
 *      进度能续（`finishBatch` 每批写一次），所以「从头再来」的说法是错的；但被掐断时
 *      复制停在半路，`waitUntil` 的 Promise 既不 resolve 也不 reject，浏览器无法判断成败、
 *      重试语义就乱了。
 *
 * 而催抓取这条路没有这些代价：服务端本来就每 `FETCH_INTERVAL`（默认 15 分钟）调度一轮，
 * SW 这一下只是把「用户刚好在断网期间」的那一轮提前，用户库写好之后页面下次打开
 * live 复制一次就补齐 —— RSS 需要的「后台同步」就是这个。
 *
 * 只有 Chromium 系有 `sync` 事件（Safari/iOS、Firefox 都没有），且必须是安全上下文。
 * 不支持时这里全部静默降级 —— 页面自己的 `online` 监听照旧负责「回到前台就同步」
 * （见 utils/networkState），两条路径最终汇到同一个恢复动作上。
 */

/** Background Sync 的 tag（public/sw.js 里有一份同名字面量，两边必须一致） */
export const BACKGROUND_SYNC_TAG = 'rssfed-sync'

/** SW 在后台同步跑完后广播给页面的消息类型 */
export const BACKGROUND_SYNC_DONE = 'BACKGROUND_SYNC_DONE'

/**
 * Background Sync 至今是 WICG 草案，TS 的 lib.dom 里没有它，只声明这里用到的一点点。
 * 不要换成 `any`：`registration.sync` 是否存在正是「浏览器支不支持」的判据。
 */
interface SyncManagerLike {
  register: (tag: string) => Promise<void>
}

type RegistrationWithSync = ServiceWorkerRegistration & { sync?: SyncManagerLike }

async function getRegistration(): Promise<RegistrationWithSync | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    // 用 getRegistration 而不是 navigator.serviceWorker.ready：注册失败时 ready 永远不 resolve，
    // 会把调用方（页面加载后的初始化）无声挂住
    return (await navigator.serviceWorker.getRegistration() as RegistrationWithSync | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * 登记一次「恢复联网后同步」，返回是否真的登记成功。
 *
 * 失败一律静默返回 false：被拒（隐私模式、用户关了后台同步）和浏览器不支持，
 * 对调用方都是同一件事 —— 走页面自己的 online 路径，不该冒泡成错误。
 */
export async function armBackgroundSync(): Promise<boolean> {
  const registration = await getRegistration()
  // 没有 registration（开发环境主动注销了 SW、或注册失败）或没有 sync（Safari/Firefox）
  const sync = registration?.sync
  if (!sync) {
    // 记下来：这是「我的后台同步为什么从来没触发」最常见的答案，
    // 而且不记的话，面板上「什么都没发生」和「日志没工作」长得一模一样
    void appendBackgroundSyncEvent(
      'unsupported',
      registration
        ? '浏览器不支持 Background Sync（Safari/iOS、Firefox 均无），恢复联网后由页面自己同步'
        : 'Service Worker 未注册，无法登记后台同步'
    )
    return false
  }
  try {
    // 同一个 tag 重复登记是幂等的：浏览器合并成一个待触发任务，不会排出一串
    await sync.register(BACKGROUND_SYNC_TAG)
    void appendBackgroundSyncEvent('armed', '已登记后台同步，等浏览器在恢复联网后触发')
    return true
  } catch (err) {
    void appendBackgroundSyncEvent(
      'arm-failed',
      '登记后台同步被拒（隐私模式或后台同步被关闭）',
      { error: errorMessage(err) }
    )
    return false
  }
}

/**
 * 只在**当前确实断网**时登记一次，返回是否真的登记成功。
 *
 * 为什么不在联网时也登记：同一个 tag 重复登记虽然幂等，但联网状态下登记会被浏览器
 * 立刻触发一次 —— 等于每进一次页面就白唤醒一次 SW，而这时页面自己的同步本来就在跑。
 * 断网时登记，它才真的等到「恢复联网」那一刻才执行。
 */
export async function armBackgroundSyncIfOffline(): Promise<boolean> {
  if (!isBrowserOffline()) return false
  return armBackgroundSync()
}

let wired = false

/**
 * 挂上「断网就登记一次」与「SW 说同步跑完了」两条线（幂等，插件里调一次）。
 *
 * 两条线都必须在 SW 注册**之前**就挂好：设备早就断网时不会有 offline 事件可听，
 * 而 SW 注册要等 load 之后 —— 漏掉这两条，整个后台同步就只在「进页面时正好断网」这一种
 * 情况下才生效。SW 注册成功后插件会再调一次 armBackgroundSyncIfOffline 补上。
 */
export function initBackgroundSync(): void {
  if (wired || typeof window === 'undefined') return
  wired = true

  window.addEventListener('offline', () => {
    void armBackgroundSync()
  })
  void armBackgroundSyncIfOffline()

  // SW 唤醒时页面可能开着但被冻结：这条消息说明服务端已经聚合过一轮，
  // 走与 online 完全相同的恢复路径（清退避 + 重挂 live 复制）即可，不必另写一套
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const type = (event.data as { type?: string } | null | undefined)?.type
      if (type === BACKGROUND_SYNC_DONE) notifyNetworkRecovered()
    })
  }
}
