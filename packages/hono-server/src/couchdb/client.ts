import nano from "nano"
import { COUCHDB_FEED_PREFIX, COUCHDB_USER_STATE_PREFIX } from "../db"

export const couchUrl = process.env.COUCHDB_URL ?? "http://localhost:5984"
export const couchUser = process.env.COUCHDB_USER ?? ""
export const couchPass = process.env.COUCHDB_PASSWORD ?? ""

/** Proxy Authentication 共享密钥，在 server 启动时设置 */
export let proxySecret = process.env.COUCHDB_PROXY_SECRET ?? ""

export function setProxySecret(s: string) {
  proxySecret = s
}

function couchUrlWithAuth(): string {
  if (couchUser && couchPass) {
    const url = new URL(couchUrl)
    url.username = couchUser
    url.password = couchPass
    return url.toString()
  }
  return couchUrl
}

export const authenticatedUrl = couchUrlWithAuth()

export const nanoServer = nano(authenticatedUrl)

/** 每个 feed 库的设计文档：entries-by-date 视图 */
const FEED_DESIGN_DOC = {
  _id: "_design/main",
  language: "javascript",
  views: {
    "entries-by-date": {
      map: `function(doc) {
        if (doc.type === 'entry') {
          emit(doc.publishedAt, { _id: doc._id });
        }
      }`,
    },
  },
}

// ── Per-Feed 数据库 ──

export function feedDbName(feedId: string): string {
  return `${COUCHDB_FEED_PREFIX}${feedId}`
}

export async function ensureFeedDatabase(feedId: string) {
  const dbName = feedDbName(feedId)
  try {
    await nanoServer.db.get(dbName)
  } catch {
    await nanoServer.db.create(dbName)
  }
  await installFeedDesignDoc(dbName)
}

async function installFeedDesignDoc(dbName: string) {
  const db = nanoServer.use(dbName)
  try {
    const existing = await db.get("_design/main")
    await db.insert({ ...FEED_DESIGN_DOC, _rev: existing._rev })
  } catch {
    await db.insert(FEED_DESIGN_DOC)
  }
}

// ── User-State 数据库 ──

export function userStateDbName(userId: string): string {
  return `${COUCHDB_USER_STATE_PREFIX}${userId}`
}

export async function ensureUserStateDatabase(userId: string) {
  const dbName = userStateDbName(userId)
  try {
    await nanoServer.db.get(dbName)
  } catch {
    await nanoServer.db.create(dbName)
  }
  // 创建 Mango index，支持按 type 查询订阅和条目状态
  await ensureUserStateIndexes(dbName)
}

async function ensureUserStateIndexes(dbName: string) {
  const db = nanoServer.use(dbName)
  const indexes = [
    { name: "type-index", fields: ["type"] },
    { name: "feedId-index", fields: ["feedId"] },
    { name: "entryId-index", fields: ["entryId"] },
  ]
  for (const idx of indexes) {
    try {
      await db.createIndex({ name: idx.name, index: { fields: idx.fields } })
    } catch {
      // index 已存在，忽略
    }
  }
}

/** 创建指定数据库的 DocumentScope 实例 */
export function createCouchDb(database: string): nano.DocumentScope<unknown> {
  return nano(authenticatedUrl).use(database)
}
