import nano from "nano"
import { customAlphabet } from "nanoid"
import { and, eq, isNull } from "drizzle-orm"
import { db, user, bots, COUCHDB_BOT_PREFIX, COUCHDB_USER_TIMELINE_PREFIX } from "../db"

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

/**
 * owner 库（用户库 / Bot 产出库）的设计文档 —— **一份**，`_design/main`。
 *
 * ## 为什么用户库与 Bot 库共用同一份
 *
 * 两个库装的东西结构相同（`feed:{feedId}` 元信息 + `entry:*` 条目 + 附件），
 * 需要的能力也相同：按时间给 outbox 分页、按源分组裁剪。差别只有一条 ——
 * 用户库多一个 `validate_doc_update` 写方向闸门（客户端可写这个库）。
 *
 * 历史上有过两份（`_design/main` 给源库、`_design/timeline-maintain` 给用户库），
 * 那是「共享源库 + 复制」时代的产物；现在没有源库了，合并成一份，视图与闸门放一起，
 * 升级时不会出现「视图装了、闸门没装」这种半到位状态。
 *
 * ## 失败的处理
 *
 * 只告警不抛：视图缺失只会让那一个源的裁剪跳过一轮 / outbox 读到空列表，
 * 不该拖垮整轮抓取。**失败不进进程内缓存**，让下一次 ensure 重试。
 */

/** 条目按发布时间排序：Bot outbox 分页 + 源库裁剪都要用 */
const ENTRIES_BY_DATE_VIEW = {
  map: `function(doc) {
    if (doc.type === 'entry') {
      emit(doc.publishedAt, { _id: doc._id });
    }
  }`,
}

/** 按 (源, 发布时间) 排序：抓取后「这个源留最新 N 条」的分组依据 */
const BY_FEED_DATE_VIEW = {
  map: `function(doc) {
    if (doc.type === 'entry' && doc.feedId) {
      emit([doc.feedId, doc.publishedAt], { _id: doc._id });
    }
  }`,
}

export const OWNER_DESIGN_DOC_VIEWS: Record<string, { map: string }> = {
  "entries-by-date": ENTRIES_BY_DATE_VIEW,
  "by-feed-date": BY_FEED_DATE_VIEW,
}

/**
 * 用户库的写方向闸门。
 *
 * 这个库同时装着「服务端独占写的抓取产物」（`entry` / `feed`）与「客户端也能写的用户状态」
 * （`subscription` / `entry-state` / `group-pref`）。不加限制的话，客户端一次误写就能影子化
 * 某个条目（同名 `entry:` 文档会让抓取侧判存在时认为它已存在从而跳过写入）。
 *
 * 用**黑名单**而不是白名单：客户端还会写 `group-pref` 这类纯状态文档，
 * 将来也可能加新的状态类型 —— 白名单每加一个类型都要连服务端设计文档一起发版，
 * 漏一个就是复制时 403、用户看到「同步失败」。真正的风险只有「污染抓取产物」一类。
 */
export const TIMELINE_VALIDATE_DOC_UPDATE = `function(newDoc, oldDoc, userCtx) {
  if (userCtx && userCtx.roles && userCtx.roles.indexOf('_admin') !== -1) return;
  var type = newDoc._deleted ? (oldDoc && oldDoc.type) : newDoc.type;
  if (type === 'entry' || type === 'feed') {
    throw({forbidden: 'entry/feed 文档由服务端抓取写入，客户端不可修改'});
  }
}`

const OWNER_DESIGN_DOC_ID = "_design/main"

/**
 * 键序无关的稳定序列化：CouchDB 存回来的对象键序不保证与写入时一致，
 * 直接 JSON.stringify 比较可能因为键序不同而每轮都重写一遍设计文档。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

/** 视图是否已与当前定义一致（键序无关比较） */
export function ownerDesignDocViewsMatch(existing: unknown): boolean {
  return stableStringify(existing ?? null) === stableStringify(OWNER_DESIGN_DOC_VIEWS)
}

const ensuredOwnerDesignDocs = new Set<string>()

/**
 * 确保 owner 库的设计文档到位（视图 + 可选的写方向闸门）。
 *
 * @param options.withWriteGate 用户库传 true（装 `validate_doc_update`）；Bot 库不传。
 *   闸门只装不改：已存在时若与当前定义不同就覆盖，与视图的升级逻辑一致。
 */
export async function ensureOwnerDesignDoc(
  dbName: string,
  options: { withWriteGate?: boolean } = {},
): Promise<boolean> {
  const cacheKey = options.withWriteGate ? `gate:${dbName}` : dbName
  if (ensuredOwnerDesignDocs.has(cacheKey)) return true
  const db = nanoServer.use(dbName)
  const validate = options.withWriteGate ? TIMELINE_VALIDATE_DOC_UPDATE : undefined
  let existing: { _rev?: string, validate_doc_update?: string, views?: Record<string, unknown> } | null = null
  try {
    existing = await db.get(OWNER_DESIGN_DOC_ID) as { _rev?: string, validate_doc_update?: string, views?: Record<string, unknown> }
  } catch {
    existing = null
  }
  const viewsOk = ownerDesignDocViewsMatch(existing?.views)
  // Bot 库不装闸门：`withWriteGate` 为假时不比较它（CouchDB 里可能压根没有这一项）
  const gateOk = !validate || existing?.validate_doc_update === validate
  if (existing && viewsOk && gateOk) {
    ensuredOwnerDesignDocs.add(cacheKey)
    return true
  }
  try {
    const mergedViews = { ...(existing?.views ?? {}), ...OWNER_DESIGN_DOC_VIEWS }
    const next: Record<string, unknown> = existing?._rev
      ? { ...existing, views: mergedViews }
      : { _id: OWNER_DESIGN_DOC_ID, language: "javascript", views: mergedViews }
    if (validate) next.validate_doc_update = validate
    await db.insert(next as never)
  } catch (err) {
    // 409 = 并发 ensure 时另一个请求已写入，等价于到位
    if ((err as { statusCode?: number })?.statusCode !== 409) {
      console.warn(`[CouchDB] owner 库 ${dbName} 的设计文档未装好（下次重试）：${(err as Error)?.message ?? err}`)
      return false
    }
  }
  ensuredOwnerDesignDocs.add(cacheKey)
  return true
}

/**
 * 确保用户库的设计文档到位（视图 + 写方向闸门）。
 *
 * 与「只在新库装」不同：闸门与视图都是后加的，存量库也必须补上，否则老库永久裸奔
 * （视图缺失还会让按源裁剪整步被跳过、库里只增不减）。
 */
export async function ensureTimelineDesignDoc(dbName: string): Promise<boolean> {
  return await ensureOwnerDesignDoc(dbName, { withWriteGate: true })
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
const OWNED_DB_PREFIXES = [COUCHDB_BOT_PREFIX, COUCHDB_USER_TIMELINE_PREFIX]

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

/**
 * 库名映射对象类型：一个用户一个库（`user-timeline`）、一个 Bot 一个产出库（`bot`）。
 *
 * `feed` 已随「共享源库」一起删除：抓取按 owner 各自进行、直接写各自的库，
 * 不再有中间库需要库名映射。
 */
type DbKind = "user-timeline" | "bot"

/**
 * 解析（或创建）业务对象对应的 CouchDB 库名。
 * 库名保存在业务表的新增列上（user.timeline_db_name / bots.couch_db_name），
 * 首次 ensure 时生成随机库名、建库并回写该列；库名不直接由业务 id 派生，
 * 避免非法字符/撞名问题，且 id 变更不影响已建库。
 *
 * **已有库名时不再检查库是否存在、也不重设 _security**：抓取条目、写条目、查条目、
 * 下单寻址等高频路径每次都要走这里，原先「每次都 get 库 + PUT _security」
 * 等于每个订阅多打两个请求。唯一例外是用户库的设计文档：里面带着写方向闸门，
 * 存量库也要补装，所以那条分支会走一次（进程内缓存）ensure。
 * 代价是不再自动修复「库名已登记但库被删掉」的情况
 * （手工删库、CouchDB 数据卷丢失）；届时把该行的库名置空即可让下次 ensure 重建：
 *   update "user" set timeline_db_name = null where id = '<userId>';
 *   update bots set couch_db_name = null where id = '<botId>';
 */
/**
 * 进程内的库名备忘：`(kind, refId) → 库名`。
 *
 * 只兜一种情况：**业务行不存在**（没有可持久化的地方）。这时 `claimCouchDbName` 每次都会
 * 生成一个新随机库名并返回，于是同一个 refId 在两次调用里拿到两个不同的库 ——
 * 表现是"写进 A 库、读从 B 库"，内容永远对不上（实测：抓取写入 5 条，按名字再查是 0 条）。
 *
 * 正常路径不依赖它：真实用户 / Bot 在业务表里都有行，库名会持久化到 `timeline_db_name` /
 * `couch_db_name`，重启后照样稳定。这张表只在"行还不存在"的窗口里起作用，
 * 且库名一旦被认领就不会再写入。
 */
const ephemeralDbNames = new Map<string, string>()

async function resolveDatabase(kind: DbKind, refId: string, prefix: string): Promise<string> {
  const memoKey = `${kind}:${refId}`
  const existing = await getCouchDbName(kind, refId) ?? ephemeralDbNames.get(memoKey) ?? null
  if (existing) {
    // 设计文档里的内容（写方向闸门 / 按源裁剪视图 / entries-by-date 视图）都是后加的，
    // 存量库也得补上 —— 而存量库走的正是这条快路径，所以这里要显式 ensure 一次。
    // 两者都进程内按库名缓存（见 ensureTimelineDesignDoc / ensureOwnerDesignDoc），
    // 稳态下只是 Set 查询，不会给高频路径加上 CouchDB 往返。
    if (kind === "user-timeline") await ensureTimelineDesignDoc(existing)
    if (kind === "bot") await ensureOwnerDesignDoc(existing)
    return existing
  }

  const dbName = `${prefix}${generateDbNameSuffix()}`
  await ensureDbExists(dbName, kind, refId)
  const claim = await claimCouchDbName(kind, refId, dbName)

  // 认领失败且回读也没有库名 = 业务行根本不存在（没有可持久化的地方）。
  // 这种情况下**仍然返回刚建的这个库**，不要删除它 —— 删掉的话调用方拿到的是一个已经不存在的
  // 库名，而下次调用又会生成另一个随机库名，于是"写进 A 库、读从 B 库"，内容永远对不上
  // （实测：两次 ensureTimelineDatabase 返回了两个不同的库名，条目写进去 5 条、按名字再查是 0 条）。
  // 正常路径不会走到这里：真实用户/ Bot 在业务表里都有行，认领会成功。

  // 并发建库：另一个请求先认领了库名。我们刚建的是**空库**（还没写过任何内容），直接删掉，
  // 改用赢家的库 —— 否则会出现"订阅写进了 A 库、之后所有解析都指向 B 库"这种丢数据的现象
  // （实测：临时账号的订阅落在自己的用户库里，但 sync-targets 下发的是另一个库）。
  if (claim.persisted && claim.dbName !== dbName) {
    try {
      await nanoServer.db.destroy(dbName)
    } catch {
      // 已删 / 正被删：忽略
    }
    if (kind === "user-timeline") await ensureTimelineDesignDoc(claim.dbName)
    if (kind === "bot") await ensureOwnerDesignDoc(claim.dbName)
    console.warn(`[CouchDB] ${kind} ${refId} 并发建库：丢弃 ${dbName}，改用 ${claim.dbName}`)
    return claim.dbName
  }
  if (!claim.persisted) {
    // 没有可持久化的行：把库名记在进程内，保证同一个 refId 后续拿到同一个库
    ephemeralDbNames.set(memoKey, dbName)
    console.warn(`[CouchDB] ${kind} ${refId} 未注册（业务行不存在），库名 ${dbName} 仅进程内有效`)
  }
  return dbName
}

/**
 * 认领库名：只在业务表这一列**还是空**的时候写（条件更新，一次 CAS）。
 *
 * 为什么需要：解析库名的路径（订阅、聚合、代理）可能**并发**走到"这一列还没有值"这一步，
 * 各自建一个库、各自写一次列值 —— 后写的赢，先写的那个库就变成**没人指得着**的孤儿
 * （用户能在里面看到自己的订阅写进去了，但之后所有读取都去另一个库）。实测有 5 个这样的
 * 残留库，而且它表现为"订阅莫名丢了"，很难查。所以这里用条件更新把"建库 + 认领"变成竞争安全的。
 *
 * 返回真正生效的库名；`persisted=false` 表示业务行还不存在（无法持久化，沿用旧行为只告警）。
 */
async function claimCouchDbName(
  kind: DbKind,
  refId: string,
  dbName: string,
): Promise<{ dbName: string, persisted: boolean }> {
  let won = false
  if (kind === "bot") {
    const rows = await db.update(bots).set({ couchDbName: dbName })
      .where(and(eq(bots.id, refId), isNull(bots.couchDbName)))
      .returning({ id: bots.id })
    won = rows.length > 0
  } else if (kind === "user-timeline") {
    const rows = await db.update(user).set({ timelineDbName: dbName })
      .where(and(eq(user.id, refId), isNull(user.timelineDbName)))
      .returning({ id: user.id })
    won = rows.length > 0
  }
  if (won) return { dbName, persisted: true }
  const existing = await getCouchDbName(kind, refId)
  if (existing) return { dbName: existing, persisted: true }
  return { dbName, persisted: false }
}

/** 读取业务表上的库名列；行不存在时返回 null */
async function getCouchDbName(kind: DbKind, refId: string): Promise<string | null> {
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
  if (kind === "bot") {
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
  // bot 库的视图只在建库时装一次（内容不会变，重装只会带来并发 409）
  if (created && kind === "bot") {
    await ensureOwnerDesignDoc(dbName)
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

// ── 用户库（合并后每用户唯一） ──

/**
 * 确保用户库存在并返回库名（首次调用时生成随机库名并持久化映射）。
 *
 * 一个用户**一个**库，它既是订阅关系的权威（`subscription:*` 文档），
 * 也是这个用户抓到的全部内容（`entry:*` 与 `feed:*`）。三类文档的写方向：
 *   - 服务端独占写：`feed:{feedId}` 元信息、`entry:*` 条目（含 AVIF 附件）、`_local/schedule`；
 *   - 客户端也能写：`subscription:*` 订阅、`entry-state:*` 已读/收藏、`group-pref:*` 分组偏好；
 *   - 独占性由设计文档里的 validate_doc_update 在数据库层兜底（见 TIMELINE_VALIDATE_DOC_UPDATE）。
 *
 * **这个库就是唯一真相**（重构后不再有共享的 `feed_*` 库）。删库 = 丢掉这个用户的阅读
 * 记录与已抓内容，重新抓 RSS 只能拿到发布方当前还列着的条目 —— 与旧模型"随时可由源库重算"
 * 不同，这是刻意的取舍（见 ARCHITECTURE.md）。
 */
export async function ensureTimelineDatabase(userId: string): Promise<string> {
  return await resolveDatabase("user-timeline", userId, COUCHDB_USER_TIMELINE_PREFIX)
}

/**
 * **另起一个**用户库并接管该用户（`ensureTimelineDatabase` 走的是"有就复用"）。
 *
 * 只在「档案损坏、需要从零开始」时用：新库是空的，客户端发现远端库名变了会丢掉本地镜像
 * 重拉一遍（见 nuxt-client 的 lastTimelineUrlKey）。用户自己写过的订阅与已读收藏需要
 * 由调用方显式搬过去 —— 目前唯一的调用方 `scripts/reset-user-timelines.ts` 刻意不搬
 * （它的语义就是"清空重来、用户自己重新导入 OPML"）。
 *
 * 注意与旧模型的区别：现在用户库**就是唯一真相**，换库等于丢掉已抓内容 ——
 * 只能靠重新抓 RSS 补回来（发布方当前还列着哪些就补哪些）。所以这条路是"抢救"而不是"重建"。
 */
export async function createTimelineDatabase(userId: string): Promise<string> {
  const dbName = `${COUCHDB_USER_TIMELINE_PREFIX}${generateDbNameSuffix()}`
  await ensureDbExists(dbName, "user-timeline", userId)
  await saveCouchDbName("user-timeline", userId, dbName)
  return dbName
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
