import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const siteSettings = pgTable('site_settings', {
  id: text('id').primaryKey(),
  // 网站基本信息
  siteName: text('site_name'),
  siteDescription: text('site_description'),
  // SEO
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  seoKeywords: text('seo_keywords'),
  // 品牌标识
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  // 主题颜色
  primaryColor: text('primary_color'),
  secondaryColor: text('secondary_color'),
  // 页脚信息
  footerText: text('footer_text'),
  // 创建和更新时间
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull()
})
