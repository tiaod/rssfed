import type { ParsedFeed } from "../rss/parser"

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
 */
export function buildFeedRegistryUpdate(url: string, parsed: ParsedFeed, now: Date = new Date()) {
  return {
    title: parsed.title ?? url,
    description: parsed.description,
    siteUrl: parsed.link,
    errorMessage: null,
    lastFetchedAt: now,
  }
}
