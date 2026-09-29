// 站点品牌/外观配置的类型定义（对应后端 /api/site-settings 系列接口）

/** 管理员可更新的品牌字段（null 表示恢复默认；缺省字段不更新） */
export interface SiteSettingsUpdate {
  siteTitle?: string | null
  description?: string | null
  primaryColor?: string | null
  skin?: string | null
  // PWA 专项配置：留空（null）时由后端按「站点品牌 → 内置默认」逐级回退
  /** 主屏幕图标下的短名（≤30 字符，建议 ≤12） */
  pwaShortName?: string | null
  /** 显示模式：standalone | minimal-ui | fullscreen | browser */
  pwaDisplay?: string | null
  /** manifest 的 theme_color（hex）；留空回退 primaryColor */
  pwaThemeColor?: string | null
  /** manifest 的 background_color 与图标底色（hex）；留空回退 primaryColor */
  pwaBackgroundColor?: string | null
}

/** PWA 显示模式的合法取值（与后端 DISPLAY_MODES 一致） */
export const PWA_DISPLAY_MODES = [
  { value: 'standalone', label: '独立窗口（推荐）', description: '隐藏浏览器地址栏，最接近原生应用' },
  { value: 'minimal-ui', label: '最小化界面', description: '保留少量浏览器控件' },
  { value: 'fullscreen', label: '全屏', description: '完全占满屏幕，无系统状态栏' },
  { value: 'browser', label: '浏览器标签页', description: '与普通网页一致，仅作为快捷方式' }
] as const

/** 公开读取的安全子集（免登录，前端渲染与服务端/本地缓存用它） */
export interface SiteSettingsPublic {
  siteTitle?: string | null
  description?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  skin?: string | null
  pwaShortName?: string | null
  pwaDisplay?: string | null
  pwaThemeColor?: string | null
  pwaBackgroundColor?: string | null
  /** PWA 方形图标 URL；为空时图标由站点 logo 裁剪或内置默认图形生成 */
  pwaIconUrl?: string | null
}

/** 管理员读取的完整视图（含内部扩展与更新时间） */
export interface SiteSettingsFull extends SiteSettingsPublic {
  extras?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
