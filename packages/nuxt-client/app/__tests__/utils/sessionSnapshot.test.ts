import { describe, it, expect, beforeEach } from 'vitest'
import {
  SESSION_SNAPSHOT_KEY,
  clearSessionSnapshot,
  readSessionSnapshot,
  sanitizeSessionUser,
  writeSessionSnapshot
} from '../../utils/sessionSnapshot'

describe('sanitizeSessionUser', () => {
  it('保留展示字段，丢弃会话 token 等额外字段', () => {
    const user = sanitizeSessionUser({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      image: 'https://cdn.example.com/a.png',
      role: 'admin',
      token: 'secret-session-token'
    })!

    expect(user).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      image: 'https://cdn.example.com/a.png',
      role: 'admin'
    })
  })

  it('没有 id 的快照一律无效', () => {
    expect(sanitizeSessionUser({})).toBeNull()
    expect(sanitizeSessionUser({ id: '   ' })).toBeNull()
    expect(sanitizeSessionUser(null)).toBeNull()
    expect(sanitizeSessionUser('alice')).toBeNull()
  })

  it('null 头像与单字段合法时可用', () => {
    const user = sanitizeSessionUser({ id: 'u1', image: null })!
    expect(user.image).toBeNull()
  })
})

describe('会话快照读写', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('写入后可读回，清空后读到 null', () => {
    writeSessionSnapshot({ id: 'u1', name: 'Alice' }, localStorage)
    expect(readSessionSnapshot(localStorage)).toEqual({ id: 'u1', name: 'Alice' })

    clearSessionSnapshot(localStorage)
    expect(readSessionSnapshot(localStorage)).toBeNull()
  })

  it('脏数据与非法 JSON 视为没有快照', () => {
    localStorage.setItem(SESSION_SNAPSHOT_KEY, 'not-json')
    expect(readSessionSnapshot(localStorage)).toBeNull()

    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({ name: 'no-id' }))
    expect(readSessionSnapshot(localStorage)).toBeNull()
  })
})
