import type { FeedValidators, ParsedFeed } from "../rss/parser"

/** 抓取时拿到的条件请求验证器来源信息（写回 `feeds` 的三列，见 db/schema.ts） */
export interface FeedFetchMeta {
  /** 验证器来源的最终 URL（重定向链最后一跳） */
  validatorUrl?: string
  etag?: string
  lastModified?: string
}

/** 从 `feeds` 表的一行还原出条件请求验证器（缺值即"没有验证器"） */
export function validatorsFromFeedRow(row: {
  fetchValidatorUrl?: string | null
  fetchEtag?: string | null
  fetchLastModified?: string | null
} | null | undefined): FeedValidators {
  return {
    url: row?.fetchValidatorUrl ?? undefined,
    etag: row?.fetchEtag ?? undefined,
    lastModified: row?.fetchLastModified ?? undefined,
  }
}

/**
 * 抓取成功后要写回 PostgreSQL `feeds` 注册表的字段。
 *
 * 抽成纯函数是为了能直接单测「抓取成功必须清掉上一轮的错误」这条不变量。
 *
 * ⚠️ errorMessage 必须显式写 `null`，不能写 `undefined`：Drizzle 的 pg dialect 在
 * buildUpdateSet 里用 `set[colName] !== void 0` 过滤字段，值为 undefined 的列**根本不会
 * 出现在 UPDATE 语句里**，等于没清 —— 上一轮失败留下的错误会一直挂在 UI 上，看起来像
 * 「这个源一直是坏的」（2026-10 线上就出现过：rsshub.app/bilibili/weekly 抓取已 200，
 * 但 error_message 仍是旧的 Request timeout）。
 *
 * 其余字段仍用 undefined 表达「这次解析不到、不要动这一列」，与 null（明确清空）区分开。
 *
 * `fetchMeta` 里的字段为 undefined 时 Drizzle 不会写该列（保留旧验证器）——这正是
 * 「这次响应没给验证器，就别把上一轮能用的弄丢」的语义，调用方负责先把新值并到旧值上。
 */
export function buildFeedRegistryUpdate(
  url: string,
  parsed: ParsedFeed,
  fetchMeta: FeedFetchMeta = {},
  now: Date = new Date(),
) {
  return {
    title: parsed.title ?? url,
    description: parsed.description,
    siteUrl: parsed.link,
    errorMessage: null,
    lastFetchedAt: now,
    fetchValidatorUrl: fetchMeta.validatorUrl,
    fetchEtag: fetchMeta.etag,
    fetchLastModified: fetchMeta.lastModified,
  }
}
