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
 * 窄屏的两级结构：先给分区列表，点进去才看具体设置。
 *
 * 分区里有的说明很长（常规分区一屏放不下四张卡），窄屏再把分区导航挤成顶部一条横排标签，
 * 用户既看不全分区、内容区又被压掉一行。改成「列表 → 详情」后，每屏只承担一件事。
 * 宽屏仍是左侧导航 + 右侧内容并排，这个状态不参与。
 */
export type SettingsPane = 'menu' | 'section'

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
  const pane = useState<SettingsPane>('settings-modal-pane', () => 'menu')
  /**
   * 「打开后直接展开同步日志」的一次性意图。
   *
   * 时间线侧栏的「有源同步失败 → 查看同步日志」要落到具体的那块面板上，而不是把用户丢到
   * 数据分区的顶部自己往下找。用状态而不是 props：入口与弹窗不在同一棵组件树上。
   */
  const wantTimelineLog = useState<boolean>('settings-modal-want-timeline-log', () => false)

  function open(next?: SettingsSection): void {
    // 不带分区 = 「打开设置」这个笼统意图：宽屏落到常规、窄屏先给分区列表；
    // 带分区 = 深链（如时间线的「查看同步日志」），两边都直接落到该分区，
    // 否则用户点了「看日志」还得在窄屏再点一次「数据」。
    section.value = next ?? 'general'
    pane.value = next ? 'section' : 'menu'
    isOpen.value = true
  }

  /** 打开数据分区并直接展开同步日志（时间线侧栏的入口） */
  function openSyncLog(): void {
    wantTimelineLog.value = true
    section.value = 'data'
    pane.value = 'section'
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

  return { isOpen, section, pane, open, close, openSyncLog, consumeTimelineLogIntent }
}
