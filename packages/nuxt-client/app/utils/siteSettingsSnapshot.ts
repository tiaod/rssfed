import type { SiteSettingsPublic } from '~/types/site'

/**
 * 站点品牌配置的本地快照。
 *
 * 公开配置平时靠 Service Worker 的 network-first 缓存兜底，但 SW 缓存会随构建号
 * 整体换掉（新版本激活时删除所有 `rssfed-*` 缓存），于是「升级后第一次断网打开」
 * 读不到任何配置，logo / 主题色 / 站点名全部回退内置默认。这里在 localStorage 里
 * 再存一份，作为 SW 缓存之外的第二层兜底。
 *
 * 只快照**渲染会用到的公开字段**：iframe 白名单属于安全策略，不从可被页面脚本
 * 任意改写的存储里恢复（离线时按内置默认处理），因此不在清单内。
 */

export const SITE_SETTINGS_SNAPSHOT_KEY = 'rssfed-site-settings'

/** 快照字段清单（读取与写入共用，保证两边口径一致） */
const SNAPSHOT_FIELDS = [
  'siteTitle',
  'description',
  'logoUrl',
  'logoDarkUrl',
  'primaryColor',
  'pwaShortName',
  'pwaDisplay',
  'pwaThemeColor',
  'pwaBackgroundColor',
  'pwaIconUrl',
  'version'
] as const

/** 单个文本字段的长度上限：脏数据不该把整份配置撑大或渲染出异常内容 */
const MAX_TEXT_LENGTH = 4096

/**
 * 把任意输入清洗成站点配置快照。
 *
 * null 有语义（管理员清空 logo / 主题色后要让旧值失效），因此 null 原样保留，
 * 只丢弃「字段不存在」与非法类型。返回 null 表示没有可用的快照。
 */
export function sanitizeSiteSettingsSnapshot(raw: unknown): SiteSettingsPublic | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const snapshot: Record<string, string | null> = {}
  let hasField = false

  for (const field of SNAPSHOT_FIELDS) {
    const value = source[field]
    if (typeof value === 'string') {
      // 空白字符串等同「未配置」，存成 null 才能覆盖掉快照里更早的旧值
      const trimmed = value.trim().slice(0, MAX_TEXT_LENGTH)
      snapshot[field] = trimmed || null
      hasField = true
    } else if (value === null) {
      snapshot[field] = null
      hasField = true
    }
  }

  return hasField ? (snapshot as SiteSettingsPublic) : null
}

/** 默认存储；SSR、隐私模式或存储被禁用时返回 null */
function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

export function readSiteSettingsSnapshot(storage: Storage | null = defaultStorage()): SiteSettingsPublic | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(SITE_SETTINGS_SNAPSHOT_KEY)
    if (!raw) return null
    return sanitizeSiteSettingsSnapshot(JSON.parse(raw))
  } catch {
    // 手改 / 旧版本格式 / 存储不可写：当作没有快照
    return null
  }
}

export function writeSiteSettingsSnapshot(
  settings: SiteSettingsPublic,
  storage: Storage | null = defaultStorage()
): void {
  if (!storage) return
  try {
    const snapshot = sanitizeSiteSettingsSnapshot(settings)
    // 没有任何可渲染字段（例如管理员把品牌配置全部清空）时删掉快照，
    // 否则旧 logo / 旧主题色会在离线时继续生效
    if (snapshot) storage.setItem(SITE_SETTINGS_SNAPSHOT_KEY, JSON.stringify(snapshot))
    else storage.removeItem(SITE_SETTINGS_SNAPSHOT_KEY)
  } catch {
    // 配额满或隐私模式：快照只是优化，写不进去不影响在线使用
  }
}
