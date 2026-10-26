/**
 * 本地库清理：找出并删除「其它账号」的时间线库（含 PouchDB 的视图库）。
 *
 * 本地库按账号隔离（见 utils/localDbName），换账号时不删旧的 —— 换回来还能离线读。
 * 代价是这个浏览器每登录过一个账号就多留一份整库副本（一个账号可能是几百 MB）。
 * 设置页给一个显式入口，让用户把用不到的账号副本清掉。
 *
 * 只清本地：其它账号的数据在服务端有权威副本，下次登录会整库重新同步。
 *
 * 为什么按 IndexedDB 的**实际库名**删：PouchDB 在 IndexedDB 里的库名带 `_pouch_` 前缀，
 * 并且 map view 会另建一个 `<逻辑名>-mrview-<md5>` 的独立库。只删主库的话视图库会留下
 * （旧版清理就踩过名字映射的坑，见 usePouchDb 的 destroyLegacyLocalDbs 注释）。
 */

import { localDbAccountKey, stripPouchNamePrefix } from './localDbName'

const TIMELINE_DB_PREFIX = 'rssfed-timeline-'

/** PouchDB map view 库的后缀：`-mrview-<md5>`（见 pouchdb 的 createView） */
const VIEW_DB_SUFFIX_RE = /-mrview-[0-9a-f]{32}$/

/**
 * 从实际库名（可带 `_pouch_` 前缀与 `-mrview-` 后缀）解析出账号段；
 * 不是时间线库（也不是它的视图库）时返回 null。
 *
 * 例：`_pouch_rssfed-timeline-abc-mrview-0123…` → `abc`
 */
export function timelineDbAccount(raw: string): string | null {
  const name = stripPouchNamePrefix(raw).replace(VIEW_DB_SUFFIX_RE, '')
  if (!name.startsWith(TIMELINE_DB_PREFIX)) return null
  const account = name.slice(TIMELINE_DB_PREFIX.length)
  return account.length > 0 ? account : null
}

/** 这个库是否属于「其它账号」——当前账号的库绝不能清 */
export function isOtherAccountTimelineDb(raw: string, userId: string | null | undefined): boolean {
  const account = timelineDbAccount(raw)
  return account !== null && account !== localDbAccountKey(userId)
}

/**
 * 从实际库名列表里挑出可清理的库（主库与视图库都在内）。
 *
 * 去重 + 排序：主库名比它的视图库名短，排序后主库先删；测试与 UI 的输入输出也因此稳定。
 */
export function pickOtherAccountTimelineDbs(
  allDbs: readonly string[],
  userId: string | null | undefined
): string[] {
  return [...new Set(allDbs.filter(db => isOtherAccountTimelineDb(db, userId)))].sort()
}

/** 这批库涉及几个账号（主库与视图库算同一个） */
export function countAccountsOfDbs(actualDbs: readonly string[]): number {
  const accounts = new Set<string>()
  for (const db of actualDbs) {
    const account = timelineDbAccount(db)
    if (account) accounts.add(account)
  }
  return accounts.size
}

/**
 * 本浏览器里所有 IndexedDB 库的实际名字。
 *
 * 只有 Chromium 系提供 `indexedDB.databases()`；拿不到就返回 null，调用方据此隐藏清理入口
 * （PouchDB 的静态 `allDbs()` 在浏览器构建里不存在，不能当回退）。
 */
export async function listActualDbNames(): Promise<string[] | null> {
  const idb = globalThis.indexedDB as
    | (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> })
    | undefined
  if (!idb || typeof idb.databases !== 'function') return null
  try {
    const entries = await idb.databases()
    return entries
      .map(entry => entry.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
  } catch {
    // 隐私模式 / 权限被拒：当作不支持，入口隐藏即可
    return null
  }
}

export interface DeleteLocalDbsResult {
  /** 真正删掉的库数 */
  deleted: number
  /** 没删掉的库数（被其它标签页占用 / 报错 / 超时） */
  failed: number
}

/**
 * 按实际库名删除（限时，逐个独立）。
 *
 * 有别的标签页开着这些库时 `deleteDatabase` 会触发 `onblocked` 且可能永不返回 ——
 * 放弃那一个，不拖住整轮清理：删不掉只是残留磁盘，下次再点即可。
 */
export async function deleteLocalDbs(
  actualNames: readonly string[],
  timeoutMs = 3000
): Promise<DeleteLocalDbsResult> {
  const idb = globalThis.indexedDB as IDBFactory | undefined
  if (!idb) return { deleted: 0, failed: actualNames.length }

  const results = await Promise.all(actualNames.map(name => new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const request = idb.deleteDatabase(name)
      request.onsuccess = () => finish(true)
      request.onerror = () => finish(false)
      request.onblocked = () => finish(false)
    } catch {
      finish(false)
    }
    // 兜底：请求既不 success 也不 blocked（浏览器极端情况）时别把整轮清理挂住
    setTimeout(() => finish(false), timeoutMs)
  })))

  let deleted = 0
  for (const ok of results) if (ok) deleted += 1
  return { deleted, failed: results.length - deleted }
}
