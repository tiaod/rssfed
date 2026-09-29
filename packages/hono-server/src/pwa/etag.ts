/**
 * HTTP 条件请求（If-None-Match）的弱比较。
 *
 * 独立成文件是为了可测：manifest 与图标两个端点共用它，而这两个路由文件都依赖
 * 数据库，单测里不方便直接调。这里保持纯函数，不碰任何外部状态。
 *
 * 为什么不直接拿 ETag 和请求头 `===`：
 * - 客户端可以一次带回多个 ETag（逗号分隔，如 `W/"a", W/"b"`）；
 * - 弱校验前缀 `W/` 在比较时应忽略（RFC 9110 §8.8.3.2）；
 * - `*` 表示「任何已存在的表示都算命中」。
 * 严格相等在这些情况下会静默失效 —— 表现为条件请求形同虚设，每次仍重传全量响应体。
 */

/** 该请求头是否命中给定 ETag（命中则响应方可回 304 且不带响应体） */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false

  /** 去掉弱校验前缀：`W/"x"` 与 `"x"` 在 If-None-Match 比较中等价 */
  const weakValue = (value: string) => value.trim().replace(/^W\//, "")
  const target = weakValue(etag)

  return ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim()
    return value === "*" || weakValue(value) === target
  })
}
