/**
 * 判断一个错误是不是「本地存储故障」：IndexedDB 配额耗尽、数据库进入 global failure 等。
 *
 * PouchDB 在这类故障下抛出的错误形状不统一：
 *   - 首个错误是 `{ status: 500, name: 'indexed_db_went_bad', reason: 'QuotaExceededError' }`；
 *   - 之后同一库上的操作会以 `new Error('')`（message 为空）立即失败。
 *
 * 之所以要单独识别：它**不是**一次普通的同步失败，而是「本地这条线已经不可用了」——
 * 时间线 live 复制的 retry 会无限重试，必须主动停下并让用户重置本地缓存，
 * 否则只会一直砸在同一块坏掉的库上（既写不进数据，又把错误刷屏）。
 */
export function isStorageFailure(e: unknown): boolean {
  if (!e) return false
  const err = e as { name?: unknown, reason?: unknown, message?: unknown, status?: unknown }
  const name = typeof err.name === 'string' ? err.name : ''
  const reason = typeof err.reason === 'string' ? err.reason : ''
  const message = typeof err.message === 'string' ? err.message : ''
  if (name === 'indexed_db_went_bad' || name === 'QuotaExceededError') return true
  if (/QuotaExceededError/i.test(reason)) return true
  if (/global failure|indexed_db_went_bad|QuotaExceededError/i.test(message)) return true
  return false
}
