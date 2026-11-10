import { resolveApiBase } from '~/utils/apiBase'
import { isBrowserOffline, onBrowserOnline } from '~/utils/networkState'

/**
 * 同步目标的虚拟 id（也是 usePouchDb 的 syncStatuses key）。
 *
 * 每个用户只有**一个**库：服务端聚合出的条目与用户自己的订阅/已读同库
 * （写方向由库里的 validate_doc_update 兜底，见 hono-server 的 couchdb/client.ts）。
 * 所以浏览器只有一个同步目标 —— 不是业务 id（feedId/botId），
 * 用一个不可能与业务 id 撞车的形态（前后双下划线）。
 */
export const TIMELINE_ID = '__timeline__'

/** 代理寻址信息：虚拟 id → 真实 CouchDB 库名，由后端 GET /api/couchdb/sync-targets 下发 */
interface CouchTargets {
  /** 用户的合并库名（条目 + 源元信息 + 订阅/已读收藏） */
  timeline: string
}

/**
 * 取寻址信息失败后的退避窗口（毫秒）。
 *
 * **为什么失败也要记住**：这个接口的调用方不是「用户点了一下」，而是 `getEntriesDb()` →
 * `ensureTimelineLiveSync()` 这条内部链路 —— 首屏里它会被调用几十次（实测离线冷启动
 * 期间 41 次）。离线/后端不可达时，「下一次调用立刻重试」的收益接近零（浏览器网络栈只会
 * 再报一次同样的失败），代价却是每个调用点各打一次网络：实测离线打开一次 /timeline 会刷出
 * 31~38 个注定失败的 sync-targets 请求。
 *
 * 取 8s 而不是更长：恢复联网有自己的短路（`online` 事件直接清退避），所以这个窗口只用来
 * 拦住「同一轮失败里的几十个并发调用点」；真断网时它每 8s 最多再试一次，代价可忽略。
 */
const FAILURE_BACKOFF_MS = 8000

// 模块级缓存：所有组件共享一份，避免每次取远端地址都打接口。
// 只放内存、不落 localStorage —— 库名与账号绑定，持久化会让同一浏览器换账号后
// 继续用上一个账号的库名（拿到 403 而非自动纠正）。
let cached: CouchTargets | null = null
let inflight: Promise<CouchTargets> | null = null
/** 请求序号：只让最新一轮的请求负责清空 inflight（invalidate 之后旧请求迟到不能清掉新的） */
let requestSeq = 0
/** 最近一次取地址失败的时刻（0 = 没有失败记录），退避窗口的起点 */
let failedAt = 0
/**
 * 失效代次：`invalidate()` 之后，上一代还没回来的请求不许再写缓存与失败记录。
 *
 * 不这么做的话会出现「用户登出 / 本地库重建 → invalidate → 旧请求迟到 → 把上一个账号的
 * 库名写回缓存」，而库名与账号绑定，那等于让新账号去连旧账号的库。
 */
let epoch = 0
/** 「恢复联网就清退避」的监听是否已注册（模块级，整个页面只注册一次） */
let onlineListenerReady = false

/** 是否在失败退避窗口内 */
function inFailureBackoff(): boolean {
  return failedAt > 0 && Date.now() - failedAt < FAILURE_BACKOFF_MS
}

/**
 * 恢复联网时立刻清掉退避。
 *
 * 不清的话，用户明明已经连上了还要等满 TTL 才恢复同步 —— 那几秒里界面看起来就是「同步坏了」，
 * 而 `online` 事件是浏览器能给出的、最可靠的「现在通了」信号（见 utils/networkState）。
 */
function ensureOnlineListener(): void {
  if (onlineListenerReady) return
  onlineListenerReady = true
  onBrowserOnline(() => {
    failedAt = 0
  })
}

/**
 * CouchDB 代理的寻址信息。
 *
 * 代理地址形如 /api/couchdb/proxy/<库名>，而库名是后端随机生成、持久化在业务表上的
 * （无法推导），所以前端必须先经 /api/couchdb/sync-targets 拿到库名。
 *
 * 这个接口只回一个库名，成本与订阅源数量无关（旧版 /targets 会为每个订阅源查一次库名，
 * 几百个订阅就是几百次查询，随逐源同步一起删掉了）。
 *
 * **失败契约**：拿不到库名时 reject（调用方一律 `.catch(() => null)` 后按「没有远端地址」
 * 降级），不返回半成品缓存。唯一的变化是失败会被退避记住，而不是每次调用都重打一遍。
 */
export function useCouchTargets() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = resolveApiBase(apiBaseUrl)

  async function fetchTargets(): Promise<CouchTargets> {
    const res = await fetch(`${base}/api/couchdb/sync-targets`, { credentials: 'include' })
    if (!res.ok) throw new Error(`获取 CouchDB 库名失败（HTTP ${res.status}）`)
    const data = await res.json() as Partial<CouchTargets>
    if (typeof data?.timeline !== 'string' || !data.timeline) {
      throw new Error('获取 CouchDB 库名失败：响应缺少 timeline')
    }
    return { timeline: data.timeline }
  }

  /** 取寻址信息（并发调用合并为同一个请求，失败进入退避窗口） */
  function getTargets(): Promise<CouchTargets> {
    if (cached) return Promise.resolve(cached)
    // 离线短路：这次请求注定失败，连浏览器网络栈都不必碰（调用方的落点与「失败」完全一样）
    if (isBrowserOffline()) {
      return Promise.reject(new Error('离线，暂时取不到 CouchDB 库名'))
    }
    if (inFailureBackoff()) {
      return Promise.reject(new Error('获取 CouchDB 库名失败（退避中，稍后重试）'))
    }
    if (inflight) return inflight

    ensureOnlineListener()
    const myEpoch = epoch
    const id = ++requestSeq
    const request = fetchTargets().then(
      (targets) => {
        // 代次变了说明期间 invalidate 过：这份结果属于旧账号 / 旧库，不许写进缓存
        if (epoch === myEpoch) {
          cached = targets
          failedAt = 0
        }
        return targets
      },
      (e: unknown) => {
        if (epoch === myEpoch) failedAt = Date.now()
        throw e
      }
    )
    inflight = request
    /** 只清自己那一轮的 inflight：invalidate 之后可能已经起了新的一轮 */
    const settle = () => {
      if (requestSeq === id) inflight = null
    }
    // 同一个 inflight 会交给多个调用方：其中任何一个忘了 catch 都会变成 unhandled rejection
    // （离线首屏控制台会一片红）。这里挂一层空的拒绝处理器把「已处理」的标记打上，
    // 对外仍然按契约 reject —— 失败语义不变，只是不再制造未处理拒绝。
    void request.then(settle, settle)
    return request
  }

  /**
   * 订阅/设置变更或本地库重建后调用：下次取地址时重新拉取。
   *
   * 同时清掉失败退避（用户登出 / 重建本地库之后必须能立刻重试），并让上一代在途请求作废。
   */
  function invalidate() {
    cached = null
    failedAt = 0
    epoch += 1
    // 在途的那个请求属于上一代：放掉引用，让下一次调用立刻发一轮新的（旧结果回来也会被代次拦掉）
    inflight = null
  }

  /** 取同步目标的库名；未知 id 返回 null（调用方按同步失败上报） */
  async function dbNameFor(id: string): Promise<string | null> {
    const targets = await getTargets()
    if (id === TIMELINE_ID) return targets.timeline || null
    return null
  }

  /** 某个同步目标的远端代理地址（PouchDB 的 remote URL）；拿不到库名返回 null */
  async function remoteUrlForId(id: string): Promise<string | null> {
    const dbName = await dbNameFor(id)
    return dbName ? `${base}/api/couchdb/proxy/${encodeURIComponent(dbName)}` : null
  }

  return { remoteUrlForId, dbNameFor, invalidate }
}
