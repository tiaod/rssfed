import { isListView, type ListView } from '~/utils/listViews'
import { isReaderFontId, type ReaderFontId } from '~/utils/readerFonts'

export type EntryModalSize = 'sm:max-w-xl' | 'sm:max-w-2xl' | 'sm:max-w-4xl' | 'sm:max-w-6xl' | 'fullscreen'

const VALID_MODAL_SIZES: EntryModalSize[] = ['sm:max-w-xl', 'sm:max-w-2xl', 'sm:max-w-4xl', 'sm:max-w-6xl', 'fullscreen']

export interface AppSettings {
  /** 条目详情模态弹窗宽度（Tailwind max-w 类） */
  entryModalSize: EntryModalSize
  /** 全屏时固定顶部栏和底部栏（关闭后随正文一起滚动） */
  fixedBars: boolean
  /**
   * 列表页默认视图（全局那一层）。
   *
   * **可选**：没配过（undefined）与「显式配成瀑布流」是两件事 —— 时间线的内置默认是社交动态
   * （见 TIMELINE_DEFAULT_VIEW），只有 undefined 时它才生效；单个订阅源 / 分组 / 收藏页
   * 没有单独配置时兜底瀑布流。页面上的切换按钮只改本次会话，不会写回这里 ——
   * 默认值只由显式配置入口修改。
   */
  view?: ListView
  /**
   * 阅读字体（只作用于文章正文，清单见 utils/readerFonts）。
   *
   * **可选**：undefined = 跟随应用默认字体，与显式选「跟随系统」等价 ——
   * 两者都归一化成 inherit，所以老版本存下来的设置不需要迁移。
   */
  readerFont?: ReaderFontId
}

const DEFAULT_SETTINGS: AppSettings = {
  entryModalSize: 'sm:max-w-6xl',
  fixedBars: true
  // view 刻意不给默认值：undefined = 用户没配过，各页回退到自己的内置默认（时间线是社交动态）
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
        // 视图值只接受枚举内的字符串（老版本 / 手改 localStorage 都可能带来非法值）
        if (!isListView(parsed.view)) {
          delete parsed.view
        }
        // 阅读字体同理：清单删过某个 id 后，旧设置不能让它变成一个认不出的字体
        if (!isReaderFontId(parsed.readerFont)) {
          delete parsed.readerFont
        }
        // 同步窗口等聚合设置已移到服务端（每用户一份，见 useTimelineSettings），
        // 存量 localStorage 里的 syncWindowDays 直接丢弃即可（不迁移：它已经没有消费者）
        delete parsed.syncWindowDays
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
