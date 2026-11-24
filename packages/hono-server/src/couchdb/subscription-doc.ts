import crypto from "node:crypto"

/**
 * 用户库里的 `subscription:{feedId}` 文档 —— 订阅关系的**唯一权威**。
 *
 * ## 为什么它带 `url`
 *
 * 旧模型里 `subscription:` 只存 `feedId`（= `sha256(url)` 截断），真实地址在 PostgreSQL 的
 * `feeds` 注册表里。现在抓取按 **owner** 各自进行、直接写自己的库，没有注册表了 ——
 * 调度读到订阅文档后必须能直接拿到抓取地址，否则 `feedId` 是不可逆的，抓什么就无从得知。
 *
 * ## 为什么 `url` 来自客户端，却仍然安全
 *
 * 这份文档是**客户端也会写**的（PouchDB 双向同步），所以 `url` 属于不可信输入：
 * 写入时（`POST /api/feeds/discover`）校验过，但用户可以直接改本地 PouchDB 再同步上来。
 * 因此**每次抓取前都必须重新过 SSRF 闸门**（`fetchFeed` 内部的 `assertFetchableUrl`，
 * 含重定向逐跳校验），不能因为"写入时查过了"就跳过。这是本模型唯一的安全回退点，
 * 也是为什么 `services/owner-fetch.ts` 不做任何"可信 URL"的假设。
 *
 * ## `feedId` 与 `url` 可能不一致
 *
 * 客户端能写出 `feedId=A, url=B`。抓取侧一律**以 `url` 为准**并重算 `deriveFeedId(url)`，
 * 与文档里的 `feedId` 不符时按脏订阅跳过（记日志，不抓）—— 否则条目会以 A 为前缀写进去，
 * 而下次按 B 派生的任务又读不到它们，形成永远的重复写入。
 */

/** 订阅文档的 `type` 值（客户端也用同一个字面量，改动要两边同步） */
export const SUBSCRIPTION_TYPE = "subscription"

/** 订阅文档 id */
export function subscriptionDocId(feedId: string): string {
  return `subscription:${feedId}`
}

/**
 * 由 URL 确定性派生 feedId：对完整 URL 做 sha256 后取 base64url 前 16 位。
 *
 * 必须保持全局一致（客户端不参与派生，但服务端所有路径都用它）：条目 doc id 形如
 * `entry:{feedId}:{hash}`，同一篇内容在不同 owner 的库里要叫同一个名字，
 * 这样"同一源在两个用户库里是同一批 `_id`"这条性质继续成立。
 */
export function deriveFeedId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("base64url").slice(0, 16)
}

/** 订阅文档（服务端读到的形状；字段都可选，历史/脏文档要能兜住） */
export interface SubscriptionDoc {
  _id: string
  _rev?: string
  type?: string
  feedId: string
  /** 抓取地址。老文档（重构前写入的）没有这个字段 —— 见 parseSubscription */
  url?: string
  title?: string
  siteUrl?: string
  description?: string
  image?: string
  category?: string
  /** 用户暂停了这个源（不抓、但保留已抓到的内容） */
  paused?: boolean
  createdAt?: string
}

export type ParsedSubscription =
  | { ok: true, feedId: string, url: string, title: string, paused: boolean }
  | { ok: false, reason: "missing-feed-id" | "missing-url" | "url-feed-id-mismatch" | "bot-subscription" }

/**
 * 校验并规范化一条订阅文档。
 *
 * 三条拒绝理由都是**静默跳过就好的脏数据**，但它们各自对应一类真实的坏状态，
 * 所以返回枚举而不是布尔：调用方要能记日志、也要能在统计里区分"没人订阅"和"订阅写坏了"。
 *
 * `kind === 'bot'` 的订阅文档（用户订阅了某个 Bot）不是 RSS 源，没有 url 也不该抓。
 */
export function parseSubscription(doc: Partial<SubscriptionDoc> & { kind?: unknown } | null | undefined): ParsedSubscription {
  if (!doc) return { ok: false, reason: "missing-feed-id" }
  if (doc.kind === "bot") return { ok: false, reason: "bot-subscription" }
  const feedId = typeof doc.feedId === "string" ? doc.feedId : ""
  if (!feedId) return { ok: false, reason: "missing-feed-id" }
  const url = typeof doc.url === "string" ? doc.url.trim() : ""
  if (!url) return { ok: false, reason: "missing-url" }
  // feedId 是 url 的哈希：不一致说明文档被写坏了（客户端可写），以 url 为准但拒绝这条，
  // 让用户重新订阅一次，而不是按错误的 id 写出一批永远读不到第二次的条目。
  if (deriveFeedId(url) !== feedId) {
    return { ok: false, reason: "url-feed-id-mismatch" }
  }
  // 标题只用于展示：首尾空白会被界面渲染成"空标题"，所以 trim 后再判空
  const title = typeof doc.title === "string" ? doc.title.trim() : ""
  return {
    ok: true,
    feedId,
    url,
    title: title.length > 0 ? title : url,
    paused: doc.paused === true,
  }
}
