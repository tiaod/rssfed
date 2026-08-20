// 站点品牌/外观配置的类型定义（对应后端 /api/site-settings 系列接口）

/** 管理员可更新的品牌字段（null 表示恢复默认；缺省字段不更新） */
export interface SiteSettingsUpdate {
  siteTitle?: string | null
  description?: string | null
  primaryColor?: string | null
  skin?: string | null
}

/** 公开读取的安全子集（免登录，前端渲染与服务端/本地缓存用它） */
export interface SiteSettingsPublic {
  siteTitle?: string | null
  description?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  skin?: string | null
}

/** 管理员读取的完整视图（含内部扩展与更新时间） */
export interface SiteSettingsFull extends SiteSettingsPublic {
  extras?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
