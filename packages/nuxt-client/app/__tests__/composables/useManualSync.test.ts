import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useManualSync } from '../../composables/useManualSync'

/**
 * 手动同步门面：toast 文案（原有行为）+ 交给调用方的结果对象。
 *
 * SyncButton 把结果转成 `synced` 事件，列表页据此判断「这一轮有没有带来新条目」：
 * added 为 0 且同步正常收尾时，才可以顺手把折叠着的「已同步 N 条」展开上屏。
 */

const H = vi.hoisted(() => ({
  syncNow: vi.fn(),
  storageBroken: null as { value: string | null } | null,
  toastAdd: vi.fn()
}))

// 只替换掉真正依赖的几样东西：同步入口、本地存储故障、toast
vi.mock('~/composables/usePouchDb', async () => {
  const { ref: rf } = await import('vue')
  return {
    usePouchDb: () => ({
      syncNow: H.syncNow,
      storageBroken: (H.storageBroken ??= rf(null) as unknown as { value: string | null })
    })
  }
})

// Nuxt auto-import 的 useToast：这里只关心给了什么反馈
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useToast = () => ({ add: H.toastAdd })

/** syncNow 的结果，用例只覆盖关心的字段 */
function syncResult(over: Partial<{
  ok: string[]
  failed: Array<{ id: string, error: string }>
  skipped: number
  cancelled: number
  added: number
}> = {}) {
  return { ok: [], failed: [], skipped: 0, cancelled: 0, added: 0, ...over }
}

beforeEach(() => {
  H.storageBroken = null
  H.syncNow.mockReset()
  H.toastAdd.mockClear()
})

describe('useManualSync（手动同步）', () => {
  it('源全部被跳过（没有新内容）→ 报「已是最新」，结果里 added 为 0', async () => {
    H.syncNow.mockResolvedValue(syncResult({ skipped: 3 }))

    const outcome = await useManualSync().sync()

    expect(outcome).toEqual({ added: 0, skipped: 3, failed: 0, cancelled: 0, storageBroken: false })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '已是最新' }))
  })

  it('有源真的复制过 → 报「同步完成」，并带上被跳过的数量', async () => {
    H.syncNow.mockResolvedValue(syncResult({ ok: ['feed-a'], skipped: 2, added: 5 }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ added: 5, skipped: 2, failed: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步完成',
      description: '另有 2 个订阅源无更新，已跳过'
    }))
  })

  it('有源失败 → 结果里报出失败数，并弹失败提示', async () => {
    H.syncNow.mockResolvedValue(syncResult({ failed: [{ id: 'feed-a', error: '网络错误' }] }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ failed: 1, added: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步失败',
      description: '网络错误',
      color: 'error'
    }))
  })

  it('用户中途暂停 → 静默收尾（不报失败），结果里 cancelled 有值', async () => {
    H.syncNow.mockResolvedValue(syncResult({ cancelled: 2 }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ cancelled: 2 })
    expect(H.toastAdd).not.toHaveBeenCalled()
  })

  it('本地存储熔断 → 结果标记 storageBroken（调用方不能据此改列表）', async () => {
    H.syncNow.mockResolvedValue(syncResult({ added: 0 }))
    const { sync } = useManualSync()
    H.storageBroken!.value = '本地缓存写入失败（存储空间不足或数据库已损坏）'

    const outcome = await sync()

    expect(outcome!.storageBroken).toBe(true)
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '本地缓存写入失败' }))
  })

  it('上一轮还在跑时再点：本轮不执行，返回 null', async () => {
    let release!: (value: unknown) => void
    H.syncNow.mockImplementation(() => new Promise((resolve) => {
      release = resolve
    }))
    const { sync } = useManualSync()

    const first = sync()
    const second = await sync()

    expect(second).toBeNull()
    expect(H.syncNow).toHaveBeenCalledTimes(1)

    release(syncResult({ added: 1 }))
    await expect(first).resolves.toMatchObject({ added: 1 })
  })
})
