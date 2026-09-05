import crypto from "node:crypto"
import { eq, and, isNull, desc } from "drizzle-orm"
import { db, apiToken, user } from "../db"

/**
 * 个人 API token 服务。
 *
 * 供 MCP server / 外部客户端以 `Authorization: Bearer <token>` 认证访问订阅数据。
 * 安全约定：
 *  - token 明文只在创建时返回一次，数据库仅存 SHA-256 hash；
 *  - 校验时对收到的 token 做 SHA-256 后比对，不可逆；
 *  - 每个 token 归属一个用户，MCP 工具据此做数据隔离。
 */

/** token 明文前缀，便于用户侧识别（如 rssfed_ab12…），也用于客户端快速判别来源 */
const TOKEN_PREFIX = "rssfed"

/** 生成一段不可预测的 token 明文（前缀 + 32 字节随机 base64url） */
function generateTokenPlain(): string {
  const random = crypto.randomBytes(32).toString("base64url")
  return `${TOKEN_PREFIX}_${random}`
}

/** 计算 token 的 SHA-256 hash（数据库存储值） */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/** 提取 token 前缀用于展示（前 12 个字符 + …） */
function prefixOf(token: string): string {
  return token.slice(0, 12) + "…"
}

/**
 * 为指定用户创建一对新 token。
 * @returns 明文 token（仅此一次返回）与持久化记录
 */
export async function createToken(userId: string, name: string, expiresAt?: Date | null) {
  const plain = generateTokenPlain()
  const [row] = await db.insert(apiToken).values({
    id: crypto.randomUUID(),
    userId,
    name: name || "api-token",
    prefix: prefixOf(plain),
    tokenHash: hashToken(plain),
    expiresAt: expiresAt ?? null,
  }).returning()
  if (!row) throw new Error("failed to create api token")
  return { token: plain, record: row }
}

/**
 * 校验一个 token 明文，返回其归属用户 id；无效/吊销/过期返回 null。
 * 校验成功时顺带刷新 lastUsedAt（不阻塞主流程，失败忽略）。
 */
export async function resolveTokenUser(token: string): Promise<string | null> {
  const tokenHash = hashToken(token)
  const [row] = await db.select()
    .from(apiToken)
    .where(and(eq(apiToken.tokenHash, tokenHash), isNull(apiToken.revokedAt)))
    .limit(1)
  if (!row) return null
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null

  // 顺带刷新最近使用时间（尽力而为，不因写失败而拒绝请求）
  db.update(apiToken).set({ lastUsedAt: new Date() })
    .where(eq(apiToken.id, row.id))
    .catch(() => {})

  // 确认用户仍存在（被删除的 token 无意义）
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, row.userId)).limit(1)
  return u ? u.id : null
}

/** 列出某用户的 token 元数据（不含 hash / 明文） */
export async function listTokens(userId: string) {
  const rows = await db.select({
    id: apiToken.id,
    name: apiToken.name,
    prefix: apiToken.prefix,
    lastUsedAt: apiToken.lastUsedAt,
    expiresAt: apiToken.expiresAt,
    revokedAt: apiToken.revokedAt,
    createdAt: apiToken.createdAt,
  }).from(apiToken)
    .where(eq(apiToken.userId, userId))
    .orderBy(desc(apiToken.createdAt))
  return rows
}

/** 吊销某用户的某个 token（幂等；不属于该用户则返回 false） */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const updated = await db.update(apiToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiToken.id, tokenId), eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
    .returning({ id: apiToken.id })
  return updated.length > 0
}
