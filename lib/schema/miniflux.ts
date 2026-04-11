import { relations } from 'drizzle-orm'
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { user } from '@@/auth-schema'

export const minifluxAccount = pgTable(
  'miniflux_account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    minifluxUserId: integer('miniflux_user_id').notNull().unique(),
    minifluxUsername: text('miniflux_username').notNull(),
    minifluxApiKey: text('miniflux_api_key'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  table => [
    index('miniflux_account_userId_idx').on(table.userId),
    index('miniflux_account_minifluxUserId_idx').on(table.minifluxUserId)
  ]
)

export const minifluxAccountRelations = relations(minifluxAccount, ({ one }) => ({
  user: one(user, {
    fields: [minifluxAccount.userId],
    references: [user.id]
  })
}))
