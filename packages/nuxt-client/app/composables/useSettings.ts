import { watch } from 'vue'

export type EntryModalSize = '4xl' | '5xl' | '6xl' | '7xl'

export interface AppSettings {
  /** 条目详情模态弹窗宽度 */
  entryModalSize: EntryModalSize
}

const DEFAULT_SETTINGS: AppSettings = {
  entryModalSize: '7xl',
}

/**
 * 应用设置：通过 useState 在组件间共享，localStorage 持久化。
 *
 * 首次在客户端调用时从 localStorage 读取已保存的偏好，之后通过 watch 自动写回。
 */
export function useSettings() {
  const settings = useState<AppSettings>('app-settings', () => ({ ...DEFAULT_SETTINGS }))

  if (import.meta.client) {
    const nuxtApp = useNuxtApp()
    if (!(nuxtApp as any)._settingsInitialized) {
      ;(nuxtApp as any)._settingsInitialized = true
      try {
        const stored = localStorage.getItem('app-settings')
        if (stored) {
          settings.value = { ...settings.value, ...JSON.parse(stored) }
        }
      } catch {
        // 解析失败忽略，使用默认值
      }

      watch(settings, (val) => {
        try {
          localStorage.setItem('app-settings', JSON.stringify(val))
        } catch {
          // 写入失败忽略
        }
      }, { deep: true })
    }
  }

  return { settings }
}
