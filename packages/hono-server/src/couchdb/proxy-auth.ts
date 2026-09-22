/**
 * CouchDB Proxy Authentication 的启动期校验。
 *
 * 背景（2026-09-22 线上事故）：
 * CouchDB **只在进程启动时**读取 `chttpd/authentication_handlers`
 * —— chttpd 启动时由 set_auth_handlers/0 解析后固化进 application env，
 * 之后再通过 config API 修改该配置对运行中的进程无效；CouchDB 3.5 又移除了
 * `POST /_restart`（实测 404），应用侧无法自行触发重载。
 *
 * 而 server 的流程是「连上 CouchDB → 用 config API 写配置」，于是 proxy handler
 * 从未挂载。后果是带 X-Auth-CouchDB-* 的转发请求全部退化成匿名用户，
 * 被库级 _security 拒绝：
 *
 *   GET /api/couchdb/proxy/feed/<id>/
 *   → 401 {"error":"unauthorized","reason":"You are not authorized to access this db."}
 *
 * 前端 PouchDB 同步因此整体失败，页面表现为「看不到任何订阅内容」。
 *
 * 正确做法是把该配置固化到 CouchDB 启动时就会读的 ini 里
 * （deploy/couchdb-proxy-auth.ini，compose 挂到 local.d/），
 * 这里只负责**启动时探测**：没生效就把原因和修复动作写进日志，
 * 避免再次以「前端空白」这种间接形式暴露。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ProxyAuthCheckOptions {
  /** CouchDB 基地址，如 http://couchdb:5984（结尾斜杠会被忽略） */
  base: string
  /** 管理员 Authorization 头的值，形如 `Basic xxx` */
  authorization: string
  fetchImpl?: FetchLike
  log?: (message: string) => void
}

const RESTART_HINT =
  "proxy handler 未挂载：CouchDB 只在启动时读取 chttpd/authentication_handlers，" +
  "请确认 deploy/couchdb-proxy-auth.ini 已挂载到 /opt/couchdb/etc/local.d/00-proxy-auth.ini" +
  "（注意挂载不能加 :ro，否则 entrypoint 的 chown 失败会让容器直接退出），" +
  "然后重启 couchdb 容器（docker compose ... restart couchdb）。" +
  "在此之前 /api/couchdb/proxy/* 会持续返回 401，前端看不到任何订阅内容。"

/** 读取 /_session，判断运行时认证链里是否真的挂载了 proxy handler */
export async function isProxyHandlerLoaded(
  base: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${stripTrailingSlash(base)}/_session`)
    if (!res.ok) return false
    const body = (await res.json()) as { info?: { authentication_handlers?: string[] } }
    return (body.info?.authentication_handlers ?? []).includes("proxy")
  } catch {
    // CouchDB 不可达时按「未加载」处理
    return false
  }
}

/** 读取节点配置，确认 authentication_handlers 里确实写了 proxy（用于区分「写失败」和「没生效」） */
export async function isProxyHandlerConfigured(
  base: string,
  authorization: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${stripTrailingSlash(base)}/_node/_local/_config/chttpd/authentication_handlers`,
      { headers: { Authorization: authorization } },
    )
    if (!res.ok) return false
    const value = await res.text()
    return value.includes("proxy_authentication_handler")
  } catch {
    return false
  }
}

/**
 * 校验运行时 proxy handler 是否已挂载；未挂载时按原因输出可执行的告警。
 *
 * @returns 是否已挂载。false 表示代理认证不可用（server 仍会启动，但同步会 401）。
 */
export async function verifyProxyAuthReady(opts: ProxyAuthCheckOptions): Promise<boolean> {
  const { base, authorization, fetchImpl = fetch, log = console.warn } = opts

  if (await isProxyHandlerLoaded(base, fetchImpl)) return true

  if (await isProxyHandlerConfigured(base, authorization, fetchImpl)) {
    log(`[CouchDB Config] ${RESTART_HINT}`)
  } else {
    log(
      "[CouchDB Config] chttpd/authentication_handlers 未包含 proxy handler，配置可能没写进去：" +
        "请检查 COUCHDB_USER / COUCHDB_PASSWORD 是否有管理员权限；" +
        "同时确认 deploy/couchdb-proxy-auth.ini 已挂载。",
    )
  }
  return false
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}
