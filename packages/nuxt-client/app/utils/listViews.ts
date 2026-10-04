/**
 * 列表视图（版式）定义。
 *
 * 纯数据、无 Nuxt / 浏览器依赖：EntryList（版式）、ListViewSwitcher（切换菜单）、
 * 设置页（默认值选择）、订阅文档读取校验都从这里取同一份枚举，避免各处写字符串。
 */

export const LIST_VIEWS = ['social', 'masonry', 'blog', 'list', 'table', 'image'] as const

export type ListView = (typeof LIST_VIEWS)[number]

/** 未配置任何默认值时的兜底视图 */
export const DEFAULT_LIST_VIEW: ListView = 'masonry'

/**
 * 时间线的内置默认视图。
 *
 * 只作用于时间线：它把「各订阅源混在一起」的信息流按社交动态呈现最合身，其余页面
 * （单源 / 分组 / 收藏）兜底仍是瀑布流。全局设置（通用设置里的「默认列表视图」）优先，
 * 见 useTimelineView；用户没配过时全局值为 undefined（不是瀑布流），两者才区分得开。
 */
export const TIMELINE_DEFAULT_VIEW: ListView = 'social'

export interface ListViewMeta {
  /** 切换菜单 / 设置页里的显示名，也是切换菜单的可访问名 */
  label: string
  /** 切换按钮与菜单项图标 */
  icon: string
}

/**
 * 只留显示名 + 图标：切换菜单是「选版式」的短清单，每种版式的长相由列表本身呈现，
 * 再挂一行说明只会把菜单撑长、把六个选项压成需要滚动的一列。
 */
export const LIST_VIEW_META: Record<ListView, ListViewMeta> = {
  // 社交动态的看点就是「谁发的」：用两个人形而不是对话气泡（气泡读起来像私信/聊天，
  // 而这版式是把各源的多条动态按发帖人排成信息流）
  social: { label: '社交动态', icon: 'i-lucide-users-round' },
  masonry: { label: '瀑布流', icon: 'i-lucide-layout-dashboard' },
  blog: { label: '博客文章', icon: 'i-lucide-newspaper' },
  list: { label: '列表', icon: 'i-lucide-rows-3' },
  table: { label: '表格', icon: 'i-lucide-table' },
  image: { label: '图片', icon: 'i-lucide-images' }
}

/** 设置页下拉选项（含「跟随上级」由调用方自行追加） */
export const LIST_VIEW_OPTIONS = LIST_VIEWS.map(value => ({
  value,
  label: LIST_VIEW_META[value].label
}))

/**
 * 校验外部输入（localStorage、CouchDB 文档）是否为合法视图值。
 * 老版本存储 / 手改文档都可能带上非法字符串，一律当作未设置。
 */
export function isListView(value: unknown): value is ListView {
  return typeof value === 'string' && (LIST_VIEWS as readonly string[]).includes(value)
}
