import nano from "nano"
import { customAlphabet } from "nanoid"
import { eq } from "drizzle-orm"
import { db, feeds, user, bots, COUCHDB_FEED_PREFIX, COUCHDB_BOT_PREFIX, COUCHDB_USER_TIMELINE_PREFIX } from "../db"

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

/**
 * 每用户库（合并后的单库，见下方 USER_DATA_* 说明）的设计文档。
 *
 * 两件事：
 *
 * 1. `views.by_published_at`：给服务端 reconcile 剪枝用（缩窗 / 退订清理，
 *    见 services/timeline.ts）。客户端从不 query 它，随复制到本地后是一份惰性文档。
 * 2. `validate_doc_update`：**单库方案的写方向闸门**。这个库同时装着「服务端独占写的
 *    聚合产物」（`entry` / `feed`）与「客户端也能写的用户状态」（`subscription` /
 *    `entry-state`），如果不加限制，客户端一次误写就可能影子化某个条目（同名 `entry:` 文档
 *    会让聚合侧的 fetchExistingIds 认为它已存在从而跳过聚合）或删掉服务端刚聚合出来的内容。
 *
 *    代理转发用的是 CouchDB **Proxy Authentication**（`X-Auth-CouchDB-UserName` + HMAC，
 *    roles=`user`，见 routes/couchdb.ts），而服务端自己的聚合走 admin 连接。所以这里可以用
 *    roles 区分「服务端」与「浏览器」：admin 放行，其余只允许写状态类文档。
 *    删除文档时 newDoc 只有 `_id/_rev/_deleted`，没有 `type`，因此取 oldDoc 的类型判断 ——
 *    否则客户端连自己的订阅都删不掉。
 *
 *    客户端本地库（PouchDB）同样会拿到这个设计文档，但 PouchDB 只在调用方显式传
 *    `ctx`（userCtx / secObj）时才执行校验，本地写入不受影响。
 *
 * 注意：设计文档本身只有 admin 能写，所以客户端改不掉这条规则。
 */
export const TIMELINE_VALIDATE_DOC_UPDATE = `function(newDoc, oldDoc, userCtx) {
  if (userCtx && userCtx.roles && userCtx.roles.indexOf('_admin') !== -1) return;
  var type = newDoc._deleted ? (oldDoc && oldDoc.type) : newDoc.type;
  if (type === 'entry' || type === 'feed') {
    throw({forbidden: 'entry/feed 文档由服务端聚合写入，客户端不可修改'});
  }
}`

/**
 * 用黑名单（只禁服务端独占的类型）而不是白名单（只放状态文档）。
 *
 * 白名单看起来更严，但客户端还会写 `group-pref`（列表分组偏好）这类纯客户端状态，
 * 将来也可能加新的状态文档类型 —— 每次都要连服务端设计文档一起发版，漏一个就是
 * 复制时 403、用户看到「同步失败」。真正的风险只有「污染服务端聚合产物」这一类，
 * 禁掉 `entry` / `feed` 就够了。
 */
const TIMELINE_DESIGN_DOC = {
  _id: "_design/timeline-maintain",
  language: "javascript",
  views: {
    by_published_at: {
      map: `function(doc) {
        if (doc.type === 'entry' && typeof doc.publishedAt === 'string') {
          emit(doc.publishedAt, null);
        }
      }`,
    },
  },
  validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
}

// ── 库名解析与创建 ──

// 全小写字母+数字字符集：生成的库名满足 CouchDB 库名规则（小写、以字母开头、无非法字符）
const DB_NAME_SUFFIX_LENGTH = 24
const generateDbNameSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", DB_NAME_SUFFIX_LENGTH)

/**
 * 本服务自己创建的库名前缀白名单（代理只转发这些库名，别的名字一律拒）。
 *
 * 历史上还有 `user-state_`：用户状态与聚合条目分两个库。合并成单库后不再创建，
 * 也不再放行（老库已废弃，见 docs/troubleshooting.md）。
 */
const OWNED_DB_PREFIXES = [COUCHDB_FEED_PREFIX, COUCHDB_BOT_PREFIX, COUCHDB_USER_TIMELINE_PREFIX]

/**
 * 库名规则：`<本服务前缀>` + 固定长度的随机小写字母数字后缀，
 * 与下方 resolveDatabase 的生成规则一一对应（改这里必须同步改生成侧）。
 */
const OWNED_DB_NAME_RE = new RegExp(
  `^(?:${OWNED_DB_PREFIXES.join("|")})[a-z0-9]{${DB_NAME_SUFFIX_LENGTH}}$`,
)

/**
 * 判断库名是否是「本服务所有、可经代理转发」的库。
 *
 * 代理路径直接携带库名（/api/couchdb/proxy/<库名>/...），所以这里必须严格白名单：
 * 既挡掉 `_users`、`_replicator` 等系统库被当成转发目标，也挡掉 `%2F`、`..`
 * 之类会改变目标 URL 结构的注入（正则只允许小写字母与数字，天然排除）。
 */
export function isProxyableDbName(name: string): boolean {
  return OWNED_DB_NAME_RE.test(name)
}

/** 库名映射对象类型（每个用户只有一个库：user-timeline；user-state 已合并进它） */
type DbKind = "feed" | "user-timeline" | "bot"

/**
 * 解析（或创建）业务对象对应的 CouchDB 库名。
 * 库名保存在业务表的新增列上（feeds.couch_db_name / user.timeline_db_name / bots.couch_db_name），
 * 首次 ensure 时生成随机库名、建库并回写该列；库名不直接由业务 id 派生，
 * 避免非法字符/撞名问题，且 id 变更不影响已建库。
 *
 * **已有库名时不再检查库是否存在、也不重设 _security**：抓取条目、写条目、查条目、
 * 下单寻址等高频路径每次都要走这里，原先「每次都 get 库 + PUT _security」
 * 等于每个订阅多打两个请求。唯一例外是用户库的设计文档：里面带着写方向闸门，
 * 存量库也要补装，所以那条分支会走一次（进程内缓存）ensure。
 * 代价是不再自动修复「库名已登记但库被删掉」的情况
 * （手工删库、CouchDB 数据卷丢失）；届时把该行的库名置空即可让下次 ensure 重建：
 *   update feeds set couch_db_name = null where id = '<feedId>';
 *   update "user" set timeline_db_name = null where id = '<userId>';  -- 时间线库同理
 */
async function resolveDatabase(kind: DbKind, refId: string, prefix: string): Promise<string> {
  const existing = await getCouchDbName(kind, refId)
  if (existing) {
    // 写方向闸门是后加的设计文档内容，存量库也得补上 —— 而存量库走的正是这条快路径，
    // 所以这里要显式 ensure 一次。进程内按库名缓存（见 ensureTimelineDesignDoc），
    // 稳态下只是 Set 查询，不会给高频路径加上 CouchDB 往返。
    if (kind === "user-timeline") await ensureTimelineDesignDoc(existing)
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
    columns: { timelineDbName: true },
  })
  return row?.timelineDbName ?? null
}

/** 将库名回写到业务表；对象未注册（行不存在）时无法持久化，仅告警 */
async function saveCouchDbName(kind: DbKind, refId: string, dbName: string) {
  let saved = false
  if (kind === "feed") {
    saved = (await db.update(feeds).set({ couchDbName: dbName }).where(eq(feeds.id, refId)).returning({ id: feeds.id })).length > 0
  } else if (kind === "bot") {
    saved = (await db.update(bots).set({ couchDbName: dbName }).where(eq(bots.id, refId)).returning({ id: bots.id })).length > 0
  } else if (kind === "user-timeline") {
    saved = (await db.update(user).set({ timelineDbName: dbName }).where(eq(user.id, refId)).returning({ id: user.id })).length > 0
  }
  if (!saved) {
    console.warn(`[CouchDB] ${kind} ${refId} 未注册，库名 ${dbName} 未持久化`)
  }
}

/** 建库（幂等）并按类型设置授权、安装设计文档/索引（只在首次建库时执行一次） */
async function ensureDbExists(dbName: string, kind: DbKind, refId: string) {
  let created = false
  try {
    await nanoServer.db.get(dbName)
  } catch {
    await nanoServer.db.create(dbName)
    created = true
  }
  // feed/bot 库的设计文档只在建库时装一次：内容不会变，重装只会带来并发 409
  if (created && (kind === "feed" || kind === "bot")) {
    await installFeedDesignDoc(dbName)
  }
  // 用户库不同：设计文档里带着写方向闸门（validate_doc_update），存量库也必须补上，
  // 所以这里**每次**都走一遍 ensure（进程内按库名缓存结果，实际只查一次）
  if (kind === "user-timeline") {
    await ensureTimelineDesignDoc(dbName)
  }
  await setDatabaseSecurity(dbName, isPerUserKind(kind) ? { names: [refId] } : { roles: ["user"] })
}

/**
 * 是否是「一个用户一个库、按用户名授权」的类型。
 *
 * 合并后只有 user-timeline 属于此类：库级 _security 的 members.names 限定为本人，
 * 代理侧授予的只是角色（见 routes/couchdb.ts），最终权限仍由这里兜底。
 */
function isPerUserKind(kind: DbKind): boolean {
  return kind === "user-timeline"
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

// ── 用户库（合并后每用户唯一） ──

/**
 * 确保用户库存在并返回库名（首次调用时生成随机库名并持久化映射）。
 *
 * 一个用户**一个**库，里面两类文档：
 *   - 服务端独占写：`feed:{feedId}` 元数据、`entry:*` 聚合条目（含从源库搬来的附件）
 *   - 客户端也能写：`subscription:*` 订阅、`entry-state:*` 已读/收藏
 * 独占性由设计文档里的 validate_doc_update 在数据库层兜底（见 TIMELINE_DESIGN_DOC）。
 *
 * 聚合产物是**派生**数据：内容全部可以从 feed/bot 库重新算出来，
 * 所以删库即「重建」，不需要任何补偿逻辑（见 services/timeline.ts 的 rebuild）。
 */
export async function ensureTimelineDatabase(userId: string): Promise<string> {
  return await resolveDatabase("user-timeline", userId, COUCHDB_USER_TIMELINE_PREFIX)
}

/**
 * 确保用户库的设计文档到位（视图 + 写方向闸门），已到位则直接返回。
 *
 * 与 feed 设计文档的区别：这里必须能**升级存量库** —— 闸门是后加的，老库（200+ 个）里没有它，
 * 而「只在新库安装」会让所有老库永久裸奔。做法是比对函数源码，不一致才带 _rev 覆盖；
 * 进程内按库名缓存，避免每次 ensure 都打一次 GET。
 */
const ensuredTimelineDesignDocs = new Set<string>()

export async function ensureTimelineDesignDoc(dbName: string) {
  if (ensuredTimelineDesignDocs.has(dbName)) return
  const db = nanoServer.use(dbName)
  try {
    const existing = await db.get(TIMELINE_DESIGN_DOC._id) as { _rev?: string, validate_doc_update?: string }
    if (existing.validate_doc_update === TIMELINE_DESIGN_DOC.validate_doc_update) {
      ensuredTimelineDesignDocs.add(dbName)
      return
    }
    await db.insert({ ...TIMELINE_DESIGN_DOC, _rev: existing._rev })
  } catch {
    try {
      await db.insert(TIMELINE_DESIGN_DOC)
    } catch {
      // 并发 ensure 时另一个请求已写入：视为已到位（下次进程内缓存命中）
    }
  }
  ensuredTimelineDesignDocs.add(dbName)
}

// ── Bot 产出库 ──

/** 确保 bot 产出库存在并返回库名（首次调用时生成随机库名并持久化映射） */
export async function ensureBotDatabase(botId: string): Promise<string> {
  const dbName = await resolveDatabase("bot", botId, COUCHDB_BOT_PREFIX)
  return dbName
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
