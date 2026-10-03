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
  /** 切换菜单 / 设置页里的显示名 */
  label: string
  /** 切换按钮与菜单项图标 */
  icon: string
  /** 设置页里的一句话说明 */
  description: string
}

export const LIST_VIEW_META: Record<ListView, ListViewMeta> = {
  social: {
    label: '社交动态',
    icon: 'i-lucide-messages-square',
    // 与 table 同样的讲究：说明里不出现其它视图的标签，菜单的可访问名才不会有歧义
    description: '头像居左的信息流：署名与正文对齐其右，配图 1 张按比例、多张铺网格'
  },
  masonry: {
    label: '瀑布流',
    icon: 'i-lucide-layout-dashboard',
    description: '封面按原比例、卡片高度随内容变化'
  },
  blog: {
    label: '博客文章',
    icon: 'i-lucide-newspaper',
    description: '统一封面比例与摘要行数，多列杂志式排版'
  },
  list: {
    label: '列表',
    icon: 'i-lucide-rows-3',
    description: '紧凑单行：小缩略图 + 标题 + 两行摘要'
  },
  table: {
    label: '表格',
    icon: 'i-lucide-table',
    // 说明里刻意不出现其它视图的标签：切换菜单的可访问名是「标签 + 说明」，而验证脚本按名字
    // 包含匹配菜单项（见 report/list-views/verify.mjs），撞词会让「列表」这类名字匹配到两项。
    description: '一行一条：来源 + 标题（后接浅灰摘要）+ 日期，像邮件客户端那样扫读'
  },
  image: {
    label: '图片',
    icon: 'i-lucide-images',
    description: '方形网格，只突出封面；没有封面的条目显示占位块'
  }
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
