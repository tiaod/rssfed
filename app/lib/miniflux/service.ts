import { randomUUID } from 'crypto'
import { ofetch } from 'ofetch'
import type { FetchError } from 'ofetch'
import { db } from '~server/lib/db'
import { minifluxAccount } from '../schema/miniflux'
import type { CreateUserRequest, User, APIKey } from './types'

export class MinifluxServiceError extends Error {
  public override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'MinifluxServiceError'
    this.cause = cause
  }
}

export class MinifluxAccountService {
  private readonly baseUrl: string
  private readonly authHeaders: Record<string, string>

  constructor() {
    const baseUrl = process.env.MINIFLUX_BASE_URL
    const username = process.env.MINIFLUX_ADMIN_USERNAME
    const password = process.env.MINIFLUX_ADMIN_PASSWORD

    if (!baseUrl || !username || !password) {
      throw new MinifluxServiceError('Miniflux 配置缺失，请检查环境变量')
    }

    this.baseUrl = `${baseUrl.replace(/\/$/, '')}/v1`
    const credentials = btoa(`${username}:${password}`)
    this.authHeaders = {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json'
    }
  }

  private generateMinifluxUsername(email: string): string {
    const username = email.split('@')[0]
    const suffix = randomUUID().split('-')[0]
    return `${username}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  }

  private generateSecurePassword(): string {
    return randomUUID().replace(/-/g, '')
  }

  private async apiPost<TResult>(path: string, body: unknown): Promise<TResult> {
    try {
      return await ofetch<TResult>(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.authHeaders,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: body as any
      })
    } catch (error) {
      const fetchError = error as FetchError
      throw new MinifluxServiceError(
        fetchError.message || 'Miniflux API 请求失败',
        error
      )
    }
  }

  private async apiDelete(path: string): Promise<void> {
    try {
      await ofetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: this.authHeaders
      })
    } catch (error) {
      const fetchError = error as FetchError
      throw new MinifluxServiceError(
        fetchError.message || 'Miniflux API 请求失败',
        error
      )
    }
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

      minifluxUser = await this.apiPost<User>('/users', createUserRequest)

      const apiKey = await this.apiPost<APIKey>('/api-keys', {
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
          await this.apiDelete(`/users/${minifluxUser.id}`)
        } catch (cleanupError) {
          console.error('清理 Miniflux 用户失败:', cleanupError)
        }
      }

      if (error instanceof MinifluxServiceError) {
        throw error
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
