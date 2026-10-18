/**
 * CouchDB 文档读取错误的判别。
 *
 * CouchDB 对「从来没存在过」和「已删除（只剩墓碑）」的文档都回 404，但两者的业务含义完全相反：
 *   - 从未存在 → 新条目，应该写入；
 *   - 已删除 → 保留策略（或人工）有意删掉的，**不能再写回**。
 * 区分依据是 404 响应体里的 `reason`：nano 会把它挂在 error.reason 上，删除场景为 `"deleted"`。
 *
 * 抽成独立模块是为了能脱离 worker（Redis/BullMQ 连接）单测。
 */
export function isDeletedDocError(err: unknown): boolean {
  return (err as { reason?: string } | null | undefined)?.reason === "deleted"
}
