/**
 * PostgreSQL 错误判定（唯一约束冲突等）。
 *
 * 为什么要单独一层：postgres.js 把原始 error 包进 `cause`，drizzle 又在外面包一层
 * `DrizzleQueryError`，只查顶层的 `code` 会漏掉真正的 23505。集中放这里，免得每个
 * 调用方各写一份、各漏一处。
 */

/** 判断是否为唯一约束冲突（23505） */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string, cause?: { code?: string } } | null | undefined
  return e?.code === "23505" || e?.cause?.code === "23505"
}
