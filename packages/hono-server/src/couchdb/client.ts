import nano from "nano"
import { customAlphabet } from "nanoid"
import { eq } from "drizzle-orm"
import { db, feeds, user, bots, COUCHDB_FEED_PREFIX, COUCHDB_USER_STATE_PREFIX, COUCHDB_BOT_PREFIX } from "../db"

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

// ── 库名解析与创建 ──

// 全小写字母+数字字符集：生成的库名满足 CouchDB 库名规则（小写、以字母开头、无非法字符）
const generateDbNameSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 24)

/** 库名映射对象类型 */
type DbKind = "feed" | "user" | "bot"

/**
 * 解析（或创建）业务对象对应的 CouchDB 库名。
 * 库名保存在业务表的新增列上（feeds.couch_db_name / user.couch_db_name），
 * 首次 ensure 时生成随机库名、建库并回写该列；库名不直接由业务 id 派生，
 * 避免非法字符/撞名问题，且 id 变更不影响已建库。
 */
async function resolveDatabase(kind: DbKind, refId: string, prefix: string): Promise<string> {
  const existing = await getCouchDbName(kind, refId)
  if (existing) {
    await ensureDbExists(existing, kind, refId)
    return existing
  }

  const dbName = `${prefix}${generateDbNameSuffix()}`
  await ensureDbExists(dbName, kind, refId)
  await saveCouchDbName(kind, refId, dbName)
  return dbName
}

/** 读取业务表上的库名列；行不存在时返回 null */
async function getCouchDbName(kind: DbKind, refId: string): Promise<string | null> {
  if (kind === "feed") {
    const row = await db.query.feeds.findFirst({
      where: eq(feeds.id, refId),
      columns: { couchDbName: true },
    })
    return row?.couchDbName ?? null
  }
  if (kind === "bot") {
    const row = await db.query.bots.findFirst({
      where: eq(bots.id, refId),
      columns: { couchDbName: true },
    })
    return row?.couchDbName ?? null
  }
  const row = await db.query.user.findFirst({
    where: eq(user.id, refId),
    columns: { couchDbName: true },
  })
  return row?.couchDbName ?? null
}

/** 将库名回写到业务表；对象未注册（行不存在）时无法持久化，仅告警 */
async function saveCouchDbName(kind: DbKind, refId: string, dbName: string) {
  let saved = false
  if (kind === "feed") {
    saved = (await db.update(feeds).set({ couchDbName: dbName }).where(eq(feeds.id, refId)).returning({ id: feeds.id })).length > 0
  } else if (kind === "bot") {
    saved = (await db.update(bots).set({ couchDbName: dbName }).where(eq(bots.id, refId)).returning({ id: bots.id })).length > 0
  } else {
    saved = (await db.update(user).set({ couchDbName: dbName }).where(eq(user.id, refId)).returning({ id: user.id })).length > 0
  }
  if (!saved) {
    console.warn(`[CouchDB] ${kind} ${refId} 未注册，库名 ${dbName} 未持久化`)
  }
}

/** 建库（幂等）并按类型设置库级授权 */
async function ensureDbExists(dbName: string, kind: DbKind, refId: string) {
  let created = false
  try {
    await nanoServer.db.get(dbName)
  } catch {
    await nanoServer.db.create(dbName)
    created = true
  }
  // 新建 feed / bot 库时一次性安装设计文档；已有库不再重写，避免每次请求重装导致的并发 409 冲突
  if (created && (kind === "feed" || kind === "bot")) {
    await installFeedDesignDoc(dbName)
  }
  await setDatabaseSecurity(dbName, kind === "user" ? { names: [refId] } : { roles: ["user"] })
}

/** 设置库级 _security：新库默认仅 admin 可读写，需显式授权 */
async function setDatabaseSecurity(
  dbName: string,
  members: { names?: string[]; roles?: string[] },
) {
  await nanoServer.request({
    db: dbName,
    doc: "_security",
    method: "PUT",
    body: {
      members: { names: members.names ?? [], roles: members.roles ?? [] },
    },
  })
}

// ── Per-Feed 数据库 ──

/** 确保 feed 库存在并返回库名（首次调用时生成随机库名并持久化映射） */
export async function ensureFeedDatabase(feedId: string): Promise<string> {
  const dbName = await resolveDatabase("feed", feedId, COUCHDB_FEED_PREFIX)
  return dbName
}

/** 安装 feed 设计文档（仅在库新建时调用，幂等；并发冲突时忽略） */
async function installFeedDesignDoc(dbName: string) {
  const db = nanoServer.use(dbName)
  try {
    await db.insert(FEED_DESIGN_DOC)
  } catch {
    // 并发创建时另一个请求可能已安装，忽略冲突
  }
}

// ── User-State 数据库 ──

/** 确保用户状态库存在并返回库名（首次调用时生成随机库名并持久化映射） */
export async function ensureUserStateDatabase(userId: string): Promise<string> {
  const dbName = await resolveDatabase("user", userId, COUCHDB_USER_STATE_PREFIX)
  await ensureUserStateIndexes(dbName)
  return dbName
}

// ── Bot 产出库 ──

/** 确保 bot 产出库存在并返回库名（首次调用时生成随机库名并持久化映射） */
export async function ensureBotDatabase(botId: string): Promise<string> {
  const dbName = await resolveDatabase("bot", botId, COUCHDB_BOT_PREFIX)
  return dbName
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

/** 确保 _users 系统库存在（消除 CouchDB 监听器报错噪音） */
export async function ensureSystemDatabases() {
  for (const name of ["_users"]) {
    try {
      await nanoServer.db.get(name)
    } catch {
      await nanoServer.db.create(name)
    }
  }
}
