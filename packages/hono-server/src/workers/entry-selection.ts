import type { ParsedItem } from "../rss/parser"

/**
 * 抓取候选条目的筛选：**只处理保留窗口内的最新 N 条**。
 *
 * 源库保留策略是「每条源只留最新 N 条」（见 `couchdb/retention.ts`）。但抓取路径原先会先把
 * feed 里列出的**全部**条目都跑一遍「存在性判断 → 下载图片 → 写库」，然后才裁剪到 N。
 * 对一个首次订阅的历史型源（实测 sciam 一次列 1982 条），这意味着几百次无意义的图片下载、
 * 1982 次 CouchDB 写 + 1932 个立刻变成墓碑的文档 —— 写放大与流量都白花。
 *
 * 既然超出 N 的条目下一刻就会被裁掉，那就不要写进来：在写库前先按发布时间截到最新 N 条。
 *
 * **注意这个窗口与裁剪窗口只是"对齐"，不是同一个全序**：并列 `publishedAt` 时本函数保持
 * feed 原有顺序，而裁剪保留的是 doc id 较大的那些（见 `retention.ts` 边界 2）。N 不变时
 * 两者覆盖同一批条目、没有差别；并列组正好跨过 N 边界时会有 1~几条每轮"写回再被裁掉"。
 * 不影响正确性，但改这里的排序口径时要连 `retention.ts` 的说明一起看。
 */

/**
 * 排序用的发布时间：与 `buildEntry` 的 `publishedAt` 回退口径保持一致
 * （pubDate → isoDate → 抓取时刻）。
 */
function itemTime(item: ParsedItem, fallback: number): number {
  const raw = item.pubDate ?? item.isoDate
  if (!raw) return fallback
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 取最新 `limit` 条（发布时间降序；同一时间保持 feed 原有顺序，便于稳定复现）。
 *
 * `limit <= 0` 或条目数不超限时原样返回（不做无谓的排序/拷贝）。
 *
 * 无发布时间的条目按**抓取时刻**算（与 buildEntry 一致），因此会排在旧条目之前 ——
 * 它们是「刚出现的内容」，保留它们比保留一堆有日期的旧存档更符合预期。
 */
export function selectNewestItems(items: ParsedItem[], limit: number, now = Date.now()): ParsedItem[] {
  if (limit <= 0 || items.length <= limit) return items
  return items
    .map((item, index) => ({ item, index, at: itemTime(item, now) }))
    .sort((a, b) => (b.at - a.at) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.item)
}
