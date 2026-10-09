import { resolveApiBase } from '~/utils/apiBase'

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

// 模块级缓存：所有组件共享一份，避免每次取远端地址都打接口。
// 只放内存、不落 localStorage —— 库名与账号绑定，持久化会让同一浏览器换账号后
// 继续用上一个账号的库名（拿到 403 而非自动纠正）。
let cached: CouchTargets | null = null
let inflight: Promise<CouchTargets> | null = null

/**
 * CouchDB 代理的寻址信息。
 *
 * 代理地址形如 /api/couchdb/proxy/<库名>，而库名是后端随机生成、持久化在业务表上的
 * （无法推导），所以前端必须先经 /api/couchdb/sync-targets 拿到库名。
 *
 * 这个接口只回一个库名，成本与订阅源数量无关（旧版 /targets 会为每个订阅源查一次库名，
 * 几百个订阅就是几百次查询，随逐源同步一起删掉了）。
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

  /** 取寻址信息（并发调用合并为同一个请求） */
  function getTargets(): Promise<CouchTargets> {
    if (cached) return Promise.resolve(cached)
    if (!inflight) {
      inflight = fetchTargets()
        .then((targets) => {
          cached = targets
          return targets
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }

  /** 订阅/设置变更或本地库重建后调用：下次取地址时重新拉取 */
  function invalidate() {
    cached = null
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

  return { remoteUrlForId, invalidate }
}
