import { describe, it, expect, afterEach } from 'vitest'
import { useStorageEstimate, formatBytes } from '../../composables/useStorageEstimate'

/**
 * 本地存储占用的读取与展示。
 *
 * 背景：PouchDB 没有「库有多大」的 API（db.info() 只有 db_name / doc_count /
 * update_seq），唯一能拿到真实占用的是 StorageManager.estimate()，而它是按
 * **整个 origin** 统计的。因此这里的重点是：读不到时安静降级、绝不抛错，
 * 以及把「支持 / 不支持」「授权 / 未授权 / 不知道」三种状态区分清楚。
 */

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')

function setStorage(value: unknown) {
  Object.defineProperty(navigator, 'storage', {
    value,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage)
  else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'storage')
})

describe('formatBytes', () => {
  it('按 1024 进制折算并带单位', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })

  it('小于 1 KB 时给出实际字节数，不显示成 0.0 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('非法输入不抛错（estimate 偶尔会给出 undefined）', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

describe('useStorageEstimate', () => {
  it('浏览器不支持 estimate 时：supported 为 false，不抛错、不显示数字', async () => {
    setStorage({})
    const { supported, info, refresh } = useStorageEstimate()
    await refresh()
    expect(supported.value).toBe(false)
    expect(info.value).toBeNull()
  })

  it('支持时读出已用 / 配额 / 比例 / 持久化授权', async () => {
    setStorage({
      estimate: async () => ({ usage: 512 * 1024, quota: 1024 * 1024 }),
      persisted: async () => true
    })
    const { supported, info, refresh } = useStorageEstimate()
    await refresh()
    expect(supported.value).toBe(true)
    expect(info.value?.usage).toBe(512 * 1024)
    expect(info.value?.quota).toBe(1024 * 1024)
    expect(info.value?.ratio).toBe(0.5)
    expect(info.value?.persisted).toBe(true)
  })

  it('读不到配额（部分浏览器只给 usage）时：quota / ratio 为 null，不编造百分比', async () => {
    setStorage({
      estimate: async () => ({ usage: 2 * 1024 * 1024 }),
      persisted: async () => false
    })
    const { info, refresh } = useStorageEstimate()
    await refresh()
    expect(info.value?.usage).toBe(2 * 1024 * 1024)
    expect(info.value?.quota).toBeNull()
    expect(info.value?.ratio).toBeNull()
    expect(info.value?.persisted).toBe(false)
  })

  it('没有 persisted API 时：persisted 为 null（区别于「明确未授权」）', async () => {
    setStorage({ estimate: async () => ({ usage: 1 }) })
    const { info, refresh } = useStorageEstimate()
    await refresh()
    expect(info.value?.persisted).toBeNull()
  })

  it('estimate 抛错（隐私模式 / 权限被拒）：安静降级，保留上次数据', async () => {
    setStorage({
      estimate: async () => { throw new Error('not allowed') },
      persisted: async () => true
    })
    const { info, refresh } = useStorageEstimate()
    await expect(refresh()).resolves.toBeUndefined()
    expect(info.value).toBeNull()
  })

  it('读取失败后再成功：数字要能恢复', async () => {
    let fail = true
    setStorage({
      estimate: async () => {
        if (fail) throw new Error('not allowed')
        return { usage: 4096, quota: 8192 }
      },
      persisted: async () => true
    })
    const { info, refresh } = useStorageEstimate()
    await refresh()
    expect(info.value).toBeNull()
    fail = false
    await refresh()
    expect(info.value?.usage).toBe(4096)
    expect(info.value?.ratio).toBe(0.5)
  })
})
