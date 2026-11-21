/**
 * Background Sync 的本地事件日志（IndexedDB，Service Worker 与页面共用）。
 *
 * 为什么**不**复用服务端那份「同步日志」（`timeline_events` 表 + `useTimelineLog`）：
 * 那是服务端视角 —— 一轮汇聚干了什么。而 Background Sync 的关键事实恰好都发生在服务端
 * 之外，且其中一半在**页面根本没打开**的时候：浏览器有没有登记成功、`sync` 事件有没有
 * 被真的派发、SW 那次 POST 拿到的是 2xx 还是 401、`waitUntil` 是不是跑完了。
 * 这些只能由 SW 自己记，而 SW 里没有 Vue、没有页面上下文，写完也未必有人读 ——
 * 所以落 IndexedDB（页面与 SW 同源共享），页面下次打开时读出来。
 *
 * 为什么不写 `localStorage`：SW 里能用，但它是同步 API 且整串读写，并发写会互相覆盖；
 * 事件流是「追加 + 读最近 N 条」，IndexedDB 的游标天然合适。
 *
 * 只记**离散状态变化**，不记每次轮询：一个 tag 的生命周期就是
 * 登记 → 被派发 → 成功/失败，再加上「不支持的浏览器」和「登记被拒」两条降级路径。
 */

/** 日志库名。刻意不带账号后缀：这是浏览器级调试信息，换账号也该看得到 */
export const BACKGROUND_SYNC_LOG_DB = 'rssfed-background-sync-log'

const STORE = 'events'
const DB_VERSION = 1
/** 只留最近这么多条：这是调试面板，不是审计日志 */
export const BACKGROUND_SYNC_LOG_KEEP = 200

/**
 * 事件类型（新增时记得同步 utils/backgroundSyncLogFormat 的文案表）：
 *   - `unsupported` 不支持 SyncManager（Safari/Firefox/非安全上下文）
 *   - `armed` 登记成功，等待浏览器触发
 *   - `arm-failed` 登记被拒（隐私模式、用户关了后台同步）
 *   - `sync-start` SW 收到 sync 事件，开始跑
 *   - `sync-ok` SW 的 POST 成功
 *   - `sync-failed` SW 的 POST 失败（含 401/403 这种「重试也没用」的）
 */
export type BackgroundSyncEventKind = 'unsupported'
  | 'armed'
  | 'arm-failed'
  | 'sync-start'
  | 'sync-ok'
  | 'sync-failed'

export interface BackgroundSyncEvent {
  /** 自增主键，越大越新 */
  id: number
  /** ISO 时间 */
  at: string
  kind: BackgroundSyncEventKind
  /** 给人看的一句话 */
  message: string
  /** 结构化补充 */
  data?: Record<string, unknown>
}

/**
 * 拿一个 IndexedDB 连接。
 *
 * `indexedDB` 在页面和 SW 里都有，但 happy-dom（单测环境）里没有 —— 调用方据此降级，
 * 不能让一个调试日志把主流程带崩。
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB
    if (!idb) {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const request = idb.open(BACKGROUND_SYNC_LOG_DB, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath 用自增 id：事件是追加流，不需要业务主键
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
    // 别的标签页占着旧版本时 onblocked 会一直不返回，别把调用方挂住
    request.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

/** 在 store 上跑一个事务并等它完成 */
function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let request: IDBRequest<T> | null = null
    const tx = db.transaction(STORE, mode)
    tx.oncomplete = () => resolve(request ? request.result : null)
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
    try {
      request = run(tx.objectStore(STORE))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * 追加一条事件。**永不抛**：写日志失败绝不能影响同步本身。
 *
 * 顺带裁剪：超过 KEEP 条就把最旧的删掉。裁剪放在写入路径上（而不是定时任务）是因为
 * SW 里没有可靠的定时器，而写入本身就是低频的。
 */
export async function appendBackgroundSyncEvent(
  kind: BackgroundSyncEventKind,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
    const event: Omit<BackgroundSyncEvent, 'id'> = {
      at: new Date().toISOString(),
      kind,
      message,
      ...(data ? { data } : {})
    }
    await withStore(db, 'readwrite', store => store.add(event))
    await pruneBackgroundSyncEvents(db)
  } catch {
    // 隐私模式 / 配额满 / 环境不支持：静默放弃
  } finally {
    db?.close()
  }
}

/** 只保留最近 KEEP 条（在同一个连接上做，省一次 open） */
async function pruneBackgroundSyncEvents(db: IDBDatabase): Promise<void> {
  const count = await withStore<number>(db, 'readonly', store => store.count())
  if (count === null || count <= BACKGROUND_SYNC_LOG_KEEP) return
  const excess = count - BACKGROUND_SYNC_LOG_KEEP
  await withStore(db, 'readwrite', (store) => {
    // 游标从小到大走，删掉最旧的 excess 条
    const request = store.openCursor()
    let deleted = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || deleted >= excess) return
      cursor.delete()
      deleted += 1
      cursor.continue()
    }
    return request
  })
}

/** 读最近的 N 条（最新在前）。读不到就返回空数组，调用方不必区分「没有」和「读不了」 */
export async function readBackgroundSyncEvents(limit = BACKGROUND_SYNC_LOG_KEEP): Promise<BackgroundSyncEvent[]> {
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
    const events = await withStore<BackgroundSyncEvent[]>(db, 'readonly', (store) => {
      const request = store.getAll()
      return request
    })
    if (!events) return []
    // getAll 是主键升序，反过来就是最新在前；再截断
    return events.slice().reverse().slice(0, limit)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

/** 清空（面板上的「清空」）。同样永不抛 */
export async function clearBackgroundSyncEvents(): Promise<void> {
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
    await withStore(db, 'readwrite', store => store.clear())
  } catch {
    // 静默
  } finally {
    db?.close()
  }
}
