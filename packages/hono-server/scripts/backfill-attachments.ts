import "dotenv/config"
import { randomUUID } from "node:crypto"
import { and, eq, isNull, not } from "drizzle-orm"
import { db, bots, user, attachments } from "../src/db"

/**
 * 一次性回填脚本：attachments 表引入前，bots.avatarUrl / user.image 里的历史 URL
 * 只有冗余列、没有附件行。本脚本为这些行补建 storageKey=null 的附件行并挂上外键，
 * 使"换头像删旧文件"的清理逻辑对历史数据同样生效（外链附件无 S3 文件，只删行）。
 * 幂等：仅处理 avatarAttachmentId 为 null 且有 URL 的行，可重复执行。
 */
async function main() {
  const dbTx = await db.transaction(async (tx) => {
    let count = 0

    // ── bots 回填 ──
    const botsWithAvatar = await tx.select().from(bots)
      .where(and(isNull(bots.avatarAttachmentId), not(isNull(bots.avatarUrl))))
    for (const bot of botsWithAvatar) {
      const [attachment] = await tx.insert(attachments).values({
        id: randomUUID(),
        storageKey: null,
        url: bot.avatarUrl!,
      }).returning()
      if (attachment) {
        await tx.update(bots).set({ avatarAttachmentId: attachment.id }).where(eq(bots.id, bot.id))
        count++
      }
    }

    // ── user 回填 ──
    const usersWithImage = await tx.select().from(user)
      .where(and(isNull(user.avatarAttachmentId), not(isNull(user.image))))
    for (const u of usersWithImage) {
      const [attachment] = await tx.insert(attachments).values({
        id: randomUUID(),
        storageKey: null,
        url: u.image!,
      }).returning()
      if (attachment) {
        await tx.update(user).set({ avatarAttachmentId: attachment.id }).where(eq(user.id, u.id))
        count++
      }
    }

    return count
  })

  console.log(`✅ 回填完成，共处理 ${dbTx} 行（bots + user）`)
  process.exit(0)
}

main().catch((error) => {
  console.error("❌ 回填失败:", error)
  process.exit(1)
})
