import type { SessionUser } from '~/types/auth'

/**
 * 会话用户的本地快照（只含展示字段，不含 token / 会话 id）。
 *
 * 登录状态本身仍以服务端为准：这里只是「后端不可达时别把已登录用户显示成未登录」。
 * 因此只存 user 的 id / name / email / image / role，服务端撤销会话后，下一次能
 * 连上后端时会拿到 null 并立刻清掉快照；离线时快照只影响界面展示，不能作为接口
 * 权限依据（离线写操作本来也全部失败）。
 *
 * 只保留单个「最后登录用户」：登出时清除，换账号登录时会被新会话覆盖，不会跨账号
 * 残留上一个用户。
 */

export const SESSION_SNAPSHOT_KEY = 'rssfed-session-user'

const MAX_TEXT_LENGTH = 512
/** 头像 URL 可能较长（带签名参数等） */
const MAX_URL_LENGTH = 4096

/**
 * 清洗任意输入为可用的会话用户；没有 id 一律视为无效。
 * role 只用于徽标展示，不参与权限判断。
 */
export function sanitizeSessionUser(raw: unknown): SessionUser | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim().slice(0, MAX_TEXT_LENGTH) : ''
  if (!id) return null

  const user: SessionUser = { id }
  if (typeof source.name === 'string') user.name = source.name.slice(0, MAX_TEXT_LENGTH)
  if (typeof source.email === 'string') user.email = source.email.slice(0, MAX_TEXT_LENGTH)
  if (typeof source.image === 'string') user.image = source.image.slice(0, MAX_URL_LENGTH)
  else if (source.image === null) user.image = null
  if (typeof source.role === 'string') user.role = source.role.slice(0, MAX_TEXT_LENGTH)
  else if (source.role === null) user.role = null
  return user
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function readSessionSnapshot(storage: Storage | null = defaultStorage()): SessionUser | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SESSION_SNAPSHOT_KEY)
    if (!raw) return null
    return sanitizeSessionUser(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeSessionSnapshot(user: SessionUser, storage: Storage | null = defaultStorage()): void {
  if (!storage) return
  try {
    const snapshot = sanitizeSessionUser(user)
    if (!snapshot) return
    const raw = JSON.stringify(snapshot)
    // 值没变化就不写，避免每次会话轮询都触发一次 localStorage 写入
    if (storage.getItem(SESSION_SNAPSHOT_KEY) === raw) return
    storage.setItem(SESSION_SNAPSHOT_KEY, raw)
  } catch {
    // 配额满 / 隐私模式：离线展示是优化项，失败不影响在线功能
  }
}

export function clearSessionSnapshot(storage: Storage | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(SESSION_SNAPSHOT_KEY)
  } catch {
    // 同上
  }
}
