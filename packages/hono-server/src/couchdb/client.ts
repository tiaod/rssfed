import nano from "nano"
import { customAlphabet } from "nanoid"
import { and, eq, isNull } from "drizzle-orm"
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

/**
 * 某个库的**带凭据** URL：复制器（`_replicator` 文档里的 source/target）专用。
 *
 * CouchDB 的复制器不接受裸库名 —— 它会把 source/target 当作 `http://any:5984/<库名>`
 * 去连，然后因为没有凭据而报 `replication_auth_error`（session_request_failed → nxdomain）。
 * 所以复制文档里的两端都必须是带凭据的完整 URL；凭据落在 `_replicator` 库里，
 * 而那个库的 `_security` 只放行 `_admin`（客户端也进不来，见 isProxyableDbName）。
 */
export function authenticatedDbUrl(dbName: string): string {
  const url = new URL(authenticatedUrl)
  url.pathname = `/${dbName}`
  return url.toString()
}

/**
 * 聚合复制用的**过滤函数**（装在 feed / bot 库的设计文档里，由复制器在源端执行）。
 *
 * 为什么是 JS filter 而不是 Mango selector —— 两条实测结论：
 *
 *   1. **selector 复制不搬删除**。Mango 只能对文档正文字段求值，而删除后的文档只有
 *      `_id/_rev/_deleted`，没有任何字段可匹配，于是被静默跳过：源端删掉的条目会在用户库里
 *      永久留着（`_changes` 里那条 `deleted:true` 根本不会被选中）。JS filter 会拿到
 *      `{_deleted: true}`，所以这里第一行就放行删除 —— 这是「源端删除 → 用户库 / 浏览器跟随删除」
 *      唯一可靠的实现方式。
 *   2. 窗口下界走 `req.query`（`query_params`）而不是写死在函数里。**参数名不能叫 `since`**：
 *      它会和 `_changes` 自己的 `since`（起始序号）撞车，filter 里读到的就成了序号字符串，
 *      于是 `publishedAt >= "0"` 恒真、窗口形同虚设。
 *
 * 窗口下界在**创建复制任务时**算一次并固定（见 couchdb/replicator.ts），所以这个过滤器只会
 * 越来越松；窗口的权威是服务端每轮的 prune（selector 变严不会删目标端已有文档）。
 */
export const TIMELINE_REPLICATION_FILTER_QUERY_PARAM = "minPublishedAt"

export const TIMELINE_REPLICATION_FILTER = `function(doc, req) {
  if (doc._deleted) return true;
  if (doc.type === 'feed') return true;
  if (doc.type !== 'entry') return false;
  var bound = req.query.${TIMELINE_REPLICATION_FILTER_QUERY_PARAM};
  if (!bound) return true;
  return typeof doc.publishedAt === 'string' && doc.publishedAt >= bound;
}`

/** 复制文档里引用过滤器的方式：`<设计文档名>/<过滤器名>` */
export const REPLICATION_FILTER_PATH = "main/timeline"

/** 每个 feed 库的设计文档：entries-by-date 视图 + 聚合复制过滤器 */
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
  filters: { timeline: TIMELINE_REPLICATION_FILTER },
}

/** 过滤器是后加的，存量 feed / bot 库要补装；进程内按库名缓存，稳态零成本 */
const ensuredReplicationFilters = new Set<string>()

/**
 * 确保源库的设计文档里带着聚合复制过滤器（幂等；**保留**已有的视图等其它内容）。
 *
 * 只在新库安装是不够的：存量 feed 库（几百个）里没有 `filters.timeline`，
 * 而复制文档引用一个不存在的过滤器会直接失败（任务进 crashing）。所以这里比对源码，
 * 不一致才带 `_rev` 覆盖；进程内缓存避免每次 ensure 都打一次 GET。
 *
 * **失败不进缓存**：写设计文档要让 CouchDB 起一次 JS 查询服务，它一忙 / 卡死就会 500
 * （真机上见过整台 CouchDB 的 JS 查询服务卡住后，所有设计文档都写不进去）。把这种失败
 * 也当成"已就位"缓存起来，等于这个进程往后每一轮 reconcile 都不再补装，而复制任务引用
 * 一个不存在的过滤器只会一直 crashing —— 用户看到的是"这个源永远不搬东西"，且没有任何信号。
 * 所以失败时打一行可定位的告警并返回 false，让下一次 ensure 重试。
 *
 * @returns 设计文档是否确实带着过滤器
 */
export async function ensureReplicationFilter(dbName: string): Promise<boolean> {
  if (ensuredReplicationFilters.has(dbName)) return true
  const db = nanoServer.use(dbName)
  // 读不到（404 = 还没装）就按"没有"处理，交给下面的写去暴露真实失败原因
  let existing: { _rev?: string, filters?: Record<string, string> } | null = null
  try {
    existing = await db.get(FEED_DESIGN_DOC._id) as { _rev?: string, filters?: Record<string, string> }
  } catch {
    existing = null
  }
  try {
    if (existing?.filters?.timeline !== TIMELINE_REPLICATION_FILTER) {
      await db.insert(existing
        ? {
            ...existing,
            filters: { ...(existing.filters ?? {}), timeline: TIMELINE_REPLICATION_FILTER },
          } as never
        : FEED_DESIGN_DOC as never)
    }
  } catch (err) {
    // 409 = 并发 ensure 时另一个请求已写入，等价于到位
    if ((err as { statusCode?: number })?.statusCode !== 409) {
      console.warn(`[CouchDB] 源库 ${dbName} 的复制过滤器未装好（下次重试）：${(err as Error)?.message ?? err}`)
      return false
    }
  }
  ensuredReplicationFilters.add(dbName)
  return true
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
/**
 * 用户库设计文档的**视图**定义（导出供升级比对与单测复用）。
 *
 * 加视图必须走这里 —— `ensureTimelineDesignDoc` 会按它比对存量库并覆盖升级；
 * 只在新建库时装的话，几百个老库会一直没有新视图（剪枝 404，窗口与保底条数一起失效）。
 */
export const TIMELINE_DESIGN_DOC_VIEWS = {
  by_published_at: {
    map: `function(doc) {
        if (doc.type === 'entry' && typeof doc.publishedAt === 'string') {
          emit(doc.publishedAt, null);
        }
      }`,
  },
  /**
   * 按「源 + 发布时间」排序（剪枝用）：保留规则是「窗口内 ∨ 该源最新 N 条」，而"最新 N 条"
   * 只有按源分组才数得出来 —— 复制过滤器只能看单条文档自己的字段，表达不了它，所以条数
   * 保底落在剪枝侧（见 services/timeline.ts 的 pruneOutsideRetention）。
   *
   * key 第一段取 `doc.feedId`（bot 产出写的是 `bot:{botId}`，与源 id 同构）；没有 feedId 的
   * 异常文档归到 `null` 那一组，至少不会因此逃过剪枝。`publishedAt` 非字符串的文档收不到 ——
   * 与老的 `by_published_at` 一样，它们本来也不会被复制进来（过滤器只放行带 publishedAt 的）。
   */
  by_feed_published_at: {
    map: `function(doc) {
        if (doc.type === 'entry' && typeof doc.publishedAt === 'string') {
          emit([typeof doc.feedId === 'string' ? doc.feedId : null, doc.publishedAt], null);
        }
      }`,
  },
}

const TIMELINE_DESIGN_DOC = {
  _id: "_design/timeline-maintain",
  language: "javascript",
  views: TIMELINE_DESIGN_DOC_VIEWS,
  validate_doc_update: TIMELINE_VALIDATE_DOC_UPDATE,
}

/**
 * 设计文档是否已经是最新：**校验函数与视图两样都要比**。
 *
 * 只比 `validate_doc_update` 曾经是个坑 —— 视图是后加的（`by_feed_published_at` 为条数保底而加），
 * 而存量库（几百个）的校验函数早就一致，于是"视图还没装"的库会被当成已就位：剪枝查一个不存在的
 * 视图 → 404 → 整个剪枝步骤每轮都被跳过（窗口与保底条数一起失效、用户库只增不减），
 * 日志里却只有一行告警。
 *
 * 比对用**键序无关**的稳定序列化：CouchDB 存回来的对象键序不保证与写入时一致，
 * 直接 JSON.stringify 比较可能因为键序不同而每轮都重写一遍设计文档。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

/** 设计文档的视图部分与代码里的一致？（键序无关比较） */
export function timelineDesignDocViewsMatch(existingViews: unknown): boolean {
  return stableStringify(existingViews ?? null) === stableStringify(TIMELINE_DESIGN_DOC.views)
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
    // 写方向闸门 / 复制过滤器都是后加的设计文档内容，存量库也得补上 —— 而存量库走的正是
    // 这条快路径，所以这里要显式 ensure 一次。两者都进程内按库名缓存
    // （见 ensureTimelineDesignDoc / ensureReplicationFilter），
    // 稳态下只是 Set 查询，不会给高频路径加上 CouchDB 往返。
    if (kind === "user-timeline") await ensureTimelineDesignDoc(existing)
    if (kind === "feed" || kind === "bot") await ensureReplicationFilter(existing)
    return existing
  }

  const dbName = `${prefix}${generateDbNameSuffix()}`
  await ensureDbExists(dbName, kind, refId)
  const claim = await claimCouchDbName(kind, refId, dbName)

  // 并发建库：另一个请求先认领了库名。我们刚建的是**空库**（还没写过任何内容），直接删掉，
  // 改用赢家的库 —— 否则会出现"订阅写进了 A 库、之后所有解析都指向 B 库"这种丢数据的现象
  // （实测：临时账号的订阅落在自己的用户库里，但 sync-targets 下发的是另一个库）。
  if (claim.dbName !== dbName) {
    try {
      await nanoServer.db.destroy(dbName)
    } catch {
      // 已删 / 正被删：忽略
    }
    if (kind === "user-timeline") await ensureTimelineDesignDoc(claim.dbName)
    if (kind === "feed" || kind === "bot") await ensureReplicationFilter(claim.dbName)
    console.warn(`[CouchDB] ${kind} ${refId} 并发建库：丢弃 ${dbName}，改用 ${claim.dbName}`)
    return claim.dbName
  }
  if (!claim.persisted) {
    console.warn(`[CouchDB] ${kind} ${refId} 未注册，库名 ${dbName} 未持久化`)
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
  if (kind === "feed") {
    const rows = await db.update(feeds).set({ couchDbName: dbName })
      .where(and(eq(feeds.id, refId), isNull(feeds.couchDbName)))
      .returning({ id: feeds.id })
    won = rows.length > 0
  } else if (kind === "bot") {
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
  // （复制过滤器随设计文档一起装，并在此标进程内缓存）
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
    await db.insert(FEED_DESIGN_DOC as never)
  } catch {
    // 并发创建时另一个请求可能已安装，忽略冲突
  }
  // 设计文档里已经带着复制过滤器，直接标缓存：新建路径不必再为了 ensure 打一次 GET
  ensuredReplicationFilters.add(dbName)
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
 * **另起一个**聚合库并接管该用户（重建用；`ensureTimelineDatabase` 走的是"有就复用"）。
 *
 * 为什么重建要换库而不是就地把内容删掉：聚合库现在是「源库窗口子集的镜像」（由复制器搬运），
 * 而复制是**变更投递不是投影** —— 目标端自己删过的文档，复制器不会再送回来（实测），
 * 所以"清空 + 重建任务"是搬不回来的。换一个空库则连 checkpoint（在库的 `_local` 里）一起消失，
 * 新的复制任务从 0 扫源库，窗口内的内容会被完整重搬一遍。
 */
export async function createTimelineDatabase(userId: string): Promise<string> {
  const dbName = `${COUCHDB_USER_TIMELINE_PREFIX}${generateDbNameSuffix()}`
  await ensureDbExists(dbName, "user-timeline", userId)
  await saveCouchDbName("user-timeline", userId, dbName)
  return dbName
}

/**
 * 确保用户库的设计文档到位（视图 + 写方向闸门），已到位则返回。
 *
 * 与 feed 设计文档的区别：这里必须能**升级存量库** —— 闸门与视图都是后加的，老库（200+ 个）
 * 里没有它们，而「只在新库安装」会让所有老库永久裸奔（视图缺失还会让剪枝整步被跳过）。
 * 做法是比对校验函数与视图源码，不一致才带 _rev 覆盖；进程内按库名缓存，避免每次 ensure 都打一次 GET。
 *
 * **失败不进缓存**（同 ensureReplicationFilter）：写设计文档要过 CouchDB 的 JS 查询服务，
 * 它一忙就 500。若把失败也缓存成"已就位"，这个进程以后每轮 reconcile 都会在剪枝那步
 * 查一个不存在的视图（404），整轮聚合直接挂掉 —— 用户看到的就是"客户端一条都同步不到"，
 * 而日志里没有任何信号。失败时告警 + 返回 false，让下一次 ensure 重试。
 *
 * @returns 设计文档是否确实在位
 */
const ensuredTimelineDesignDocs = new Set<string>()

export async function ensureTimelineDesignDoc(dbName: string): Promise<boolean> {
  if (ensuredTimelineDesignDocs.has(dbName)) return true
  const db = nanoServer.use(dbName)
  let existing: { _rev?: string, validate_doc_update?: string, views?: unknown } | null = null
  try {
    existing = await db.get(TIMELINE_DESIGN_DOC._id) as { _rev?: string, validate_doc_update?: string, views?: unknown }
  } catch {
    existing = null
  }
  if (
    existing?.validate_doc_update === TIMELINE_DESIGN_DOC.validate_doc_update
    && timelineDesignDocViewsMatch(existing.views)
  ) {
    ensuredTimelineDesignDocs.add(dbName)
    return true
  }
  try {
    await db.insert(existing?._rev ? { ...TIMELINE_DESIGN_DOC, _rev: existing._rev } : TIMELINE_DESIGN_DOC)
  } catch (err) {
    // 409 = 并发 ensure 时另一个请求已写入，等价于到位
    if ((err as { statusCode?: number })?.statusCode !== 409) {
      console.warn(`[CouchDB] 用户库 ${dbName} 的设计文档未装好（下次重试）：${(err as Error)?.message ?? err}`)
      return false
    }
  }
  ensuredTimelineDesignDocs.add(dbName)
  return true
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
