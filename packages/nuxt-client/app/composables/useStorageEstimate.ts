import { ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 本地存储占用估算。
 *
 * 前端拿不到「某一个 PouchDB 库有多大」：PouchDB 的 `db.info()` 只返回
 * db_name / doc_count / update_seq（见 @types/pouchdb-core 的 DatabaseInfo），
 * 底层 IndexedDB 也没有按库统计体积的接口（`size` 选项是给 Safari 传**上限**，
 * 既不是上限查询，也不是真实占用）。`disk_size` / `data_size` 只存在于
 * CouchDB 服务端的 `GET /db` 响应里。
 *
 * 因此这里用 StorageManager.estimate()：它给出的是**本 origin（整个站点）**的
 * 用量与配额，包含 IndexedDB（PouchDB 的条目库、用户状态库）、Cache Storage
 * （Service Worker 的预缓存）与 localStorage。展示时必须按「整个站点」来描述，
 * 否则用户会以为这是单个数据库的大小。
 *
 * 能力探测与失败降级都要有：estimate() 在不支持的浏览器上不存在，
 * 在隐私模式 / 配额查询被拒绝时会抛错 —— 两种情况下都只是「不显示」，
 * 绝不能让设置页因此报错。
 */

export interface StorageEstimateInfo {
  /** 已用字节 */
  usage: number
  /** 浏览器给本 origin 的配额上限（字节），取不到时为 null */
  quota: number | null
  /** 已用占配额的比例（0-1），配额取不到时为 null */
  ratio: number | null
  /**
   * 是否已获得持久化存储授权（persisted）。
   *
   * true 表示浏览器不会在磁盘紧张时自动清理本 origin 的数据 —— 对「离线可读」
   * 这个卖点很关键；false / null 时数据可能在空间不足时被浏览器回收。
   * 取不到（不支持该 API）时返回 null。
   */
  persisted: boolean | null
}

export function useStorageEstimate() {
  const info: Ref<StorageEstimateInfo | null> = ref(null)
  const loading = ref(false)
  /** 浏览器是否支持容量估算（不支持时 UI 直接不显示这一项） */
  const supported = ref(false)

  async function refresh() {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (typeof storage?.estimate !== 'function') {
      supported.value = false
      return
    }
    supported.value = true
    loading.value = true
    try {
      const estimate = await storage.estimate()
      const usage = estimate.usage ?? 0
      const quota = estimate.quota ?? null
      info.value = {
        usage,
        quota,
        ratio: quota && quota > 0 ? Math.min(1, usage / quota) : null,
        persisted: await readPersisted(storage)
      }
    } catch {
      // 隐私模式 / 权限被拒：保留上一次的数据（比清空更有用），没有就保持不显示
    } finally {
      loading.value = false
    }
  }

  return { info, loading, supported, refresh }
}

/** 读取持久化授权状态；不支持该 API 时返回 null（区别于明确未授权） */
async function readPersisted(storage: StorageManager): Promise<boolean | null> {
  if (typeof storage.persisted !== 'function') return null
  try {
    return await storage.persisted()
  } catch {
    return null
  }
}

/**
 * 字节数的人类可读文案（1024 进制）。
 *
 * 与「存储配额」的常见口径一致：浏览器自己的 estimate() 也按 1024 进制折算。
 * 小于 1 KB 时给出实际字节数 —— 显示「0.0 KB」会让「缓存是空的吗」更难判断。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // B 是整数，其余保留一位小数（1.5 MB 这样的粒度足够判断占用是否异常）
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}
