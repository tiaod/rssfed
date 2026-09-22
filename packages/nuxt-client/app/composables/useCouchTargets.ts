import { resolveApiBase } from '~/utils/apiBase'

/** 用户状态库在同步队列里的虚拟 id（与 usePouchDb 的 syncStatuses key 一致） */
export const USER_STATE_ID = '__user_state__'

/** 代理寻址信息：业务 id → 真实 CouchDB 库名，由后端 GET /api/couchdb/targets 下发 */
interface CouchTargets {
  /** 用户状态库名（已读/收藏/订阅） */
  userState: string
  /** feedId → feed 库名 */
  feeds: Record<string, string>
  /** botId → bot 产出库名 */
  bots: Record<string, string>
}

/** 未命中缓存时强制刷新的冷却时间：避免脏 id（服务端已无此订阅）每次同步都打一次较重的 targets 接口 */
const REFRESH_COOLDOWN_MS = 10_000

// 模块级缓存：所有组件共享一份，避免每次取远端地址都打接口。
// 只放内存、不落 localStorage —— 库名与账号绑定，持久化会让同一浏览器换账号后
// 继续用上一个账号的库名（拿到 403 而非自动纠正）。
let cached: CouchTargets | null = null
let inflight: Promise<CouchTargets> | null = null
let lastRefreshAt = 0

/** 从寻址信息里取某个业务 id 的库名；找不到返回 null */
function pickDbName(targets: CouchTargets, id: string): string | null {
  if (id === USER_STATE_ID) return targets.userState || null
  if (id.startsWith('bot:')) return targets.bots[id.slice('bot:'.length)] ?? null
  return targets.feeds[id] ?? null
}

/**
 * CouchDB 代理的寻址信息。
 *
 * 代理地址形如 /api/couchdb/proxy/<库名>，而库名是后端随机生成、持久化在业务表上的
 * （无法由 feedId/botId 推导），所以前端必须先经 /api/couchdb/targets 拿到库名。
 */
export function useCouchTargets() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = resolveApiBase(apiBaseUrl)

  async function fetchTargets(): Promise<CouchTargets> {
    const res = await fetch(`${base}/api/couchdb/targets`, { credentials: 'include' })
    if (!res.ok) throw new Error(`获取 CouchDB 库名失败（HTTP ${res.status}）`)
    const data = await res.json() as Partial<CouchTargets>
    if (typeof data?.userState !== 'string' || !data.userState) {
      throw new Error('获取 CouchDB 库名失败：响应缺少 userState')
    }
    return { userState: data.userState, feeds: data.feeds ?? {}, bots: data.bots ?? {} }
  }

  /** 取寻址信息（并发调用合并为同一个请求） */
  function getTargets(): Promise<CouchTargets> {
    if (cached) return Promise.resolve(cached)
    if (!inflight) {
      inflight = fetchTargets()
        .then((targets) => {
          cached = targets
          lastRefreshAt = Date.now()
          return targets
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }

  /** 订阅关系变更后调用：下次取地址时重新拉取 */
  function invalidate() {
    cached = null
  }

  /** 取某个业务 id（feedId / `bot:<botId>` / USER_STATE_ID）对应的库名 */
  async function dbNameFor(id: string): Promise<string | null> {
    const hit = pickDbName(await getTargets(), id)
    if (hit) return hit
    // 缓存里没有这个 id —— 别的设备刚订阅、或本地有服务端已删的脏订阅。
    // 强制刷新一次再试（带冷却，避免脏 id 反复触发刷新）。
    if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return null
    invalidate()
    return pickDbName(await getTargets(), id)
  }

  /** 某个业务 id 的远端代理地址（PouchDB 的 remote URL）；拿不到库名返回 null */
  async function remoteUrlForId(id: string): Promise<string | null> {
    const dbName = await dbNameFor(id)
    return dbName ? `${base}/api/couchdb/proxy/${encodeURIComponent(dbName)}` : null
  }

  return { remoteUrlForId, invalidate }
}
