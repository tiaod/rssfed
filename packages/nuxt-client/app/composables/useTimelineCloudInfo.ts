import { ref } from 'vue'
import type { Ref } from 'vue'
import { TIMELINE_ID, useCouchTargets } from '~/composables/useCouchTargets'

/**
 * 云端聚合库（CouchDB 用户库）的体积与文档数。
 *
 * 数字来自 CouchDB 的 `GET /{db}`（浏览器经 `/api/couchdb/proxy/<库名>` 直通，
 * 见 hono-server 的 routes/couchdb.ts）：响应的 `sizes` 有三档口径，含义不同，不能混用：
 *
 *   - `sizes.external`：**活文档**的未压缩字节（JSON 正文 + 附件解码后的字节），
 *     不含旧修订与墓碑。它与「一次全量同步要过的数据量」最接近
 *     （附件在复制里走 base64 内嵌，线上字节再大约 1/3）。
 *   - `sizes.active`：库文件里活数据的体积（附件已按 CouchDB 的压缩策略存储）。
 *   - `sizes.file`：库文件总大小，含墓碑与未 compact 的旧修订 —— 可能比 external 大一倍以上，
 *     拿它估同步量会严重高估，只用于排障。
 *
 * 为什么在浏览器里直接读、不加后端接口：PouchDB 复制用的就是这个代理地址，前端已经持有
 * 远端库 URL，GET 一次库根即可（代理对「只有库名、没有库内路径」的请求就是转发 `GET /{db}/`）。
 *
 * 本地占用拿不到同口径的数字：PouchDB 的 `db.info()` 没有体积字段，IndexedDB 也没有按库
 * 统计的接口 —— 本地那一侧用 StorageManager.estimate()（见 useStorageEstimate），
 * 口径是「整个站点」，展示时必须这么写。
 */
export interface TimelineCloudInfo {
  /** 活文档数（不含墓碑） */
  docCount: number
  /** 活数据的未压缩体积（JSON + 附件）；估「要同步多少」用这一档 */
  externalSize: number | null
  /** 库文件里活数据的体积（附件已压缩） */
  activeSize: number | null
  /** 库文件总大小（含墓碑与旧修订；只用于排障，不用来估同步量） */
  fileSize: number | null
  /** 库的 update_seq（用来识别「云端的库换了一个」；不在 UI 上展示） */
  updateSeq: string | number | null
}

/** `GET /{db}` 响应里本模块关心的形状（其余字段忽略） */
interface CouchDbInfoPayload {
  doc_count?: unknown
  sizes?: { external?: unknown, active?: unknown, file?: unknown }
  update_seq?: unknown
}

/** 非负有限数字才算有效（CouchDB 在极端情况下会给 null / 缺字段） */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 把 CouchDB `GET /{db}` 的响应裁成 UI 需要的形状（纯函数，便于单测）。
 *
 * 拿不到 `doc_count` 就返回 null：说明这个响应不是库信息（代理根路径返回的是另一份欢迎信息），
 * 这时候连体积也不该信。
 */
export function readCloudInfo(payload: unknown): TimelineCloudInfo | null {
  const body = payload as CouchDbInfoPayload | null
  if (!body || typeof body !== 'object') return null
  const docCount = nonNegativeNumber(body.doc_count)
  if (docCount === null) return null
  return {
    docCount,
    externalSize: nonNegativeNumber(body.sizes?.external),
    activeSize: nonNegativeNumber(body.sizes?.active),
    fileSize: nonNegativeNumber(body.sizes?.file),
    updateSeq: typeof body.update_seq === 'string' || typeof body.update_seq === 'number'
      ? body.update_seq
      : null
  }
}

/**
 * 缓存有效期（毫秒）。
 *
 * 云端体积只随「服务端聚合出新条目」变化，量级是分钟级的；组件每次悬停/挂载都会调 refresh，
 * 没有缓存的话弹层一悬停就是一次请求。60 秒足够跟上变化，又不会把请求打散。
 */
const CACHE_TTL_MS = 60_000

/**
 * 模块级缓存：指示器与进度条各构造一份闭包，用缓存合并请求（只在浏览器里写，见 fetchInfo）。
 *
 * 缓存按**远端库 URL** 记：库名是每账号随机的，换成另一个账号后 URL 一定不同，
 * 这样不会把上一个账号的库体积显示给当前账号（库名相同才视为同一份缓存）。
 */
let cached: TimelineCloudInfo | null = null
let cachedFor: string | null = null
let cachedAt = 0
let inflight: { url: string, promise: Promise<TimelineCloudInfo | null> } | null = null

export function useTimelineCloudInfo() {
  const { remoteUrlForId } = useCouchTargets()
  const info: Ref<TimelineCloudInfo | null> = ref(null)
  const loading = ref(false)

  /** 打一次代理请求读库信息；任何失败都返回 null（由调用方决定降级） */
  async function fetchInfo(url: string): Promise<TimelineCloudInfo | null> {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return null
    return readCloudInfo(await res.json())
  }

  /**
   * 读取云端库体积。
   *
   * force=false 时命中缓存直接返回；失败静默保留上一次的数据 —— 体积只是辅助信息，
   * 不能因为它让同步 UI 报错或闪一下消失。
   */
  async function refresh(force = false): Promise<TimelineCloudInfo | null> {
    // 只在浏览器里读：SSR 阶段没有用户的登录 cookie 可转发，问出来只会是 401
    if (typeof window === 'undefined') return null
    const url = await remoteUrlForId(TIMELINE_ID).catch(() => null)
    if (!url) return null

    if (!force && cached && cachedFor === url && Date.now() - cachedAt < CACHE_TTL_MS) {
      info.value = cached
      return cached
    }
    // 并发调用合并成一个请求（弹层与顶部进度条会同时挂载）
    if (inflight && inflight.url === url) {
      const shared = await inflight.promise
      if (shared) info.value = shared
      return shared
    }
    loading.value = true
    const entry = {
      url,
      promise: fetchInfo(url)
        .then((result) => {
          if (result) {
            cached = result
            cachedFor = url
            cachedAt = Date.now()
          }
          return result
        })
        .catch(() => null)
        .finally(() => {
          if (inflight === entry) inflight = null
          loading.value = false
        })
    }
    inflight = entry
    const result = await entry.promise
    if (result) info.value = result
    else if (cachedFor === url && cached) info.value = cached
    return result
  }

  return { info, loading, refresh }
}
