import { randomUUID } from 'crypto'
import { db } from '../db'
import { minifluxAccount } from '../schema/miniflux'
import { MinifluxClient, MinifluxError } from './client'
import type { CreateUserRequest, User } from './types'

export class MinifluxServiceError extends Error {
  public override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'MinifluxServiceError'
    this.cause = cause
  }
}

export class MinifluxAccountService {
  private readonly client: MinifluxClient

  constructor() {
    const baseUrl = process.env.MINIFLUX_BASE_URL
    const username = process.env.MINIFLUX_ADMIN_USERNAME
    const password = process.env.MINIFLUX_ADMIN_PASSWORD

    if (!baseUrl || !username || !password) {
      throw new MinifluxServiceError('Miniflux 配置缺失，请检查环境变量')
    }

    this.client = new MinifluxClient({ baseUrl, username, password })
  }

  private generateMinifluxUsername(email: string): string {
    const username = email.split('@')[0]
    const suffix = randomUUID().split('-')[0]
    return `${username}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  }

  private generateSecurePassword(): string {
    return randomUUID().replace(/-/g, '')
  }

  async createMinifluxAccount(userId: string, userEmail: string): Promise<void> {
    let minifluxUser: User | null = null

    try {
      const minifluxUsername = this.generateMinifluxUsername(userEmail)
      const minifluxPassword = this.generateSecurePassword()

      const createUserRequest: CreateUserRequest = {
        username: minifluxUsername,
        password: minifluxPassword,
        is_admin: false
      }

      minifluxUser = await this.client.createUser(createUserRequest)

      const apiKey = await this.client.createAPIKey({
        description: `API Key for user ${userId}`
      })

      await db.insert(minifluxAccount).values({
        id: randomUUID(),
        userId,
        minifluxUserId: minifluxUser.id,
        minifluxUsername,
        minifluxApiKey: apiKey.token,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    } catch (error) {
      if (minifluxUser?.id) {
        try {
          await this.client.deleteUser(minifluxUser.id)
        } catch (cleanupError) {
          console.error('清理 Miniflux 用户失败:', cleanupError)
        }
      }

      if (error instanceof MinifluxError) {
        throw new MinifluxServiceError(
          `Miniflux API 错误: ${error.message}`,
          error
        )
      }

      throw new MinifluxServiceError(
        `创建 Miniflux 账户失败: ${(error as Error).message}`,
        error
      )
    }
  }

  async getMinifluxAccount(userId: string) {
    return await db.query.minifluxAccount.findFirst({
      where: (account, { eq }) => eq(account.userId, userId)
    })
  }
}

export const minifluxAccountService = new MinifluxAccountService()
