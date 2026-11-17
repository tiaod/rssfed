/**
 * 设置弹窗的全局状态。
 *
 * 设置不再是独立页面：它从侧边栏用户菜单（以及时间线的「查看同步日志」）以弹窗打开，
 * 用户不会因此离开当前正在读的列表 —— 这是换成弹窗的主要理由（原先 /profile?tab=1
 * 会把列表、滚动位置和阅读栏整块丢掉）。
 *
 * 状态放在 useState 里而不是组件内 ref：入口分散在布局、用户菜单、时间线侧栏，
 * 它们和弹窗不在同一棵组件树上。与 useEntryModal 同一套做法。
 */

/** 弹窗左侧导航的分区（顺序即导航顺序，见 SETTINGS_SECTIONS） */
export type SettingsSection = 'general' | 'ai' | 'data'

/**
 * 设置行的图标底色。
 *
 * 只做「一组行一个色系」的视觉分组，不带任何语义（红色不表示危险）；
 * 具体的类名映射在 SettingsRow 里，这里只给允许的取值，免得各处随手写 className。
 */
export type SettingsTone = 'blue' | 'purple' | 'orange' | 'red' | 'green' | 'slate'

export interface SettingsSectionMeta {
  value: SettingsSection
  label: string
  icon: string
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { value: 'general', label: '常规', icon: 'i-lucide-settings-2' },
  { value: 'ai', label: 'AI 助手', icon: 'i-lucide-bot' },
  { value: 'data', label: '数据', icon: 'i-lucide-database' }
]

export function useSettingsModal() {
  const isOpen = useState<boolean>('settings-modal-open', () => false)
  const section = useState<SettingsSection>('settings-modal-section', () => 'general')
  /**
   * 「打开后直接展开同步日志」的一次性意图。
   *
   * 时间线侧栏的「有源同步失败 → 查看同步日志」要落到具体的那块面板上，而不是把用户丢到
   * 数据分区的顶部自己往下找。用状态而不是 props：入口与弹窗不在同一棵组件树上。
   */
  const wantTimelineLog = useState<boolean>('settings-modal-want-timeline-log', () => false)

  function open(next?: SettingsSection): void {
    if (next) section.value = next
    isOpen.value = true
  }

  /** 打开数据分区并直接展开同步日志（时间线侧栏的入口） */
  function openSyncLog(): void {
    wantTimelineLog.value = true
    section.value = 'data'
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  /** 日志面板展开后由数据分区消费掉这个意图，避免下次打开又自动展开 */
  function consumeTimelineLogIntent(): boolean {
    const wanted = wantTimelineLog.value
    wantTimelineLog.value = false
    return wanted
  }

  return { isOpen, section, open, close, openSyncLog, consumeTimelineLogIntent }
}
