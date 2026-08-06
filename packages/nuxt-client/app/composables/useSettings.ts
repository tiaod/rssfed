export type EntryModalSize = 'sm:max-w-xl' | 'sm:max-w-2xl' | 'sm:max-w-4xl' | 'sm:max-w-6xl' | 'fullscreen'

const VALID_MODAL_SIZES: EntryModalSize[] = ['sm:max-w-xl', 'sm:max-w-2xl', 'sm:max-w-4xl', 'sm:max-w-6xl', 'fullscreen']

export interface AppSettings {
  /** 条目详情模态弹窗宽度（Tailwind max-w 类） */
  entryModalSize: EntryModalSize
  /** 全屏时固定顶部栏和底部栏（关闭后随正文一起滚动） */
  fixedBars: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  entryModalSize: 'sm:max-w-6xl',
  fixedBars: true,
}

// 首次在客户端调用时从 localStorage 读取持久化的设置（模块级标记，避免重复读取）
let storageLoaded = false

/**
 * 应用设置：通过 useState 在组件间共享，localStorage 持久化。
 *
 * 修改需通过 updateSettings 显式保存。
 */
export function useSettings() {
  const settings = useState<AppSettings>('app-settings', () => ({ ...DEFAULT_SETTINGS }))

  if (import.meta.client && !storageLoaded) {
    storageLoaded = true
    try {
      const stored = localStorage.getItem('app-settings')
      if (stored) {
        const parsed = JSON.parse(stored)
        // 过滤旧版本存储的无效宽度值（如 '7xl'），回退到默认
        if (!VALID_MODAL_SIZES.includes(parsed.entryModalSize)) {
          delete parsed.entryModalSize
        }
        settings.value = { ...settings.value, ...parsed }
      }
    } catch {
      // 解析失败忽略，使用默认值
    }
  }

  /**
   * 更新设置并持久化到 localStorage（显式保存，不会自动写回）。
   */
  const updateSettings = (patch: Partial<AppSettings>) => {
    settings.value = { ...settings.value, ...patch }
    if (import.meta.client) {
      localStorage.setItem('app-settings', JSON.stringify(settings.value))
    }
  }

  return { settings, updateSettings }
}
