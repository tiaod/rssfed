import { eq } from "drizzle-orm"
import { auth } from "./auth"
import { db, user } from "./db"

/**
 * 环境变量引导创建管理员账号（幂等，服务启动时调用）
 *
 * 约定：
 * - 同时设置了 ADMIN_EMAIL 和 ADMIN_PASSWORD 时才生效
 * - 目标邮箱已存在则跳过，不会覆盖或重复创建
 * - 可用 ADMIN_NAME 自定义显示名（默认"管理员"）
 */
export async function bootstrapAdminFromEnv(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim()
  const password = process.env.ADMIN_PASSWORD
  const name = process.env.ADMIN_NAME?.trim() || "管理员"

  // 未配置管理员引导，直接跳过
  if (!email) return

  if (!password) {
    console.warn("[Admin Bootstrap] 已设置 ADMIN_EMAIL 但缺少 ADMIN_PASSWORD，跳过管理员创建")
    return
  }

  try {
    // 邮箱已存在则不重复创建（幂等）
    const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
    if (existing.length > 0) {
      console.log(`[Admin Bootstrap] 管理员账号 ${email} 已存在，跳过创建`)
      return
    }

    await auth.api.createUser({
      body: {
        email,
        name,
        password,
        role: "admin" as const,
      },
    })
    console.log(`[Admin Bootstrap] 已创建管理员账号: ${email}`)
  } catch (err) {
    console.error("[Admin Bootstrap] 创建管理员失败:", err)
  }
}
