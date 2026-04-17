import { pgTable, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { user } from './auth'

export const files = pgTable('files', {
  id: text('id').primaryKey(),
  // 使用哪个存储适配器（local、s3、r2 等）
  storage: text('storage').notNull(),
  // 存储端文件名（通常是 UUID）
  filenameDisk: text('filename_disk').notNull(),
  // 下载时使用的原始文件名
  filenameDownload: text('filename_download').notNull(),
  // MIME 类型
  type: text('type').notNull(),
  // 文件大小（字节）
  size: integer('size').notNull(),
  // 标题/描述
  title: text('title'),
  // 标签
  tags: jsonb('tags').$type<string[]>(),
  // 图片/视频尺寸
  width: integer('width'),
  height: integer('height'),
  // 时长（音视频）
  duration: integer('duration'),
  // 是否公开可访问
  isPublic: boolean('is_public').default(false),
  // 上传用户
  uploadedBy: text('uploaded_by')
    .references(() => user.id, { onDelete: 'set null' }),
  // 存储路径（相对于存储根目录）
  path: text('path').default('').notNull(),
  // 额外元数据
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull()
})

export const filesRelations = relations(files, ({ one }) => ({
  uploader: one(user, {
    fields: [files.uploadedBy],
    references: [user.id]
  })
}))
