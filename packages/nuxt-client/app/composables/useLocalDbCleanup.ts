import { computed, ref } from 'vue'
import { errorMessage } from '~/utils/errorMessage'
import {
  countAccountsOfDbs,
  deleteLocalDbs,
  listActualDbNames,
  pickOtherAccountTimelineDbs
} from '~/utils/localDbCleanup'

/**
 * 设置页「其它账号的本地缓存」的状态。
 *
 * 只负责两件事：扫出可清理的库、执行清理后如实重新扫一遍。真正的命名判断与 IndexedDB
 * 操作在 utils/localDbCleanup（纯函数与带兜底的 I/O），这里只包一层响应式状态。
 *
 * 扫不到（浏览器不支持 `indexedDB.databases()`）时 `supported` 为 false，设置页隐藏这个入口 ——
 * 与其显示一个永远「没有缓存」的假结论，不如不显示。
 */
export function useLocalDbCleanup() {
  /** 浏览器能否枚举 IndexedDB 库（Chromium 系才有 databases()） */
  const supported = ref(false)
  /** 正在扫描 */
  const scanning = ref(false)
  /** 正在清理 */
  const cleaning = ref(false)
  /** 清理没删干净时的原因（被其它标签页占用等） */
  const error = ref<string | null>(null)
  /** 待清理的实际库名（含主库与视图库） */
  const dbNames = ref<string[]>([])
  /** 这些库涉及几个其它账号（主库与视图库算同一个） */
  const accountCount = computed(() => countAccountsOfDbs(dbNames.value))
  /** 有没有可清理的库 */
  const canClean = computed(() => dbNames.value.length > 0)

  /** 扫一遍：应该清理的是哪些库（当前账号的库永远不在结果里） */
  async function scan(userId: string | null | undefined): Promise<void> {
    scanning.value = true
    error.value = null
    try {
      const names = await listActualDbNames()
      supported.value = names !== null
      dbNames.value = names ? pickOtherAccountTimelineDbs(names, userId) : []
    } finally {
      scanning.value = false
    }
  }

  /**
   * 清理扫出来的库，返回删除结果。
   *
   * 删完一定重新扫：被别的标签页占用的库会原样留着，卡片要如实显示而不是假装清空成功。
   */
  async function clean(userId: string | null | undefined): Promise<{ deleted: number, failed: number, accounts: number }> {
    if (cleaning.value) return { deleted: 0, failed: 0, accounts: 0 }
    // 账号未知时一律不动：此时分不清哪个库是当前账号的，删错就是当前账号的离线数据全丢。
    // （会话就绪前 user id 为 null，设置页不会走到这里；这条是兜底。）
    if (!userId) return { deleted: 0, failed: 0, accounts: 0 }
    cleaning.value = true
    error.value = null
    const targets = dbNames.value.slice()
    const accounts = countAccountsOfDbs(targets)
    try {
      const result = await deleteLocalDbs(targets)
      // 先重扫（scan 会清掉 error），再按结果写失败原因 —— 顺序反了会把原因冲掉
      await scan(userId)
      if (result.failed > 0) {
        error.value = `${result.failed} 个库被其它标签页占用，未能删除；关掉其它页面后再试一次`
      }
      return { ...result, accounts }
    } catch (e: unknown) {
      error.value = errorMessage(e)
      return { deleted: 0, failed: targets.length, accounts }
    } finally {
      cleaning.value = false
    }
  }

  return {
    supported,
    scanning,
    cleaning,
    error,
    dbNames,
    accountCount,
    canClean,
    scan,
    clean
  }
}
