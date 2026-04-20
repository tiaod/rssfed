import { ofetch } from 'ofetch'
import type { FetchError } from 'ofetch'
import type {
  ErrorResponse,
  Subscription,
  DiscoverRequest,
  Feed,
  CreateFeedRequest,
  UpdateFeedRequest,
  Entry,
  EntriesRequest,
  UpdateEntryRequest,
  UpdateEntriesStatusRequest,
  Enclosure,
  UpdateEnclosureRequest,
  Category,
  CreateCategoryRequest,
  UpdateCategoryRequest,
  User,
  CreateUserRequest,
  UpdateUserRequest,
  APIKey,
  CreateAPIKeyRequest,
  UnreadReadCounters,
  VersionInfo
} from './types'

/**
 * Miniflux API 客户端错误类
 */
export class MinifluxError extends Error {
  public readonly statusCode?: number
  public readonly errorMessage?: string

  constructor(message: string, statusCode?: number, errorMessage?: string) {
    super(message)
    this.name = 'MinifluxError'
    this.statusCode = statusCode
    this.errorMessage = errorMessage
  }
}

/**
 * Miniflux API 客户端配置选项
 */
export interface MinifluxClientOptions {
  baseUrl: string
  username?: string
  password?: string
  apiKey?: string
}

/**
 * Miniflux API 客户端
 */
export class MinifluxClient {
  private readonly fetch: ReturnType<typeof ofetch.create>

  /**
   * 创建 Miniflux 客户端实例
   * @param options 客户端配置选项
   * @example
   * ```typescript
   * // 使用 API Key 认证（推荐）
   * const client = new MinifluxClient({
   *   baseUrl: 'https://miniflux.example.org',
   *   apiKey: 'your-api-key'
   * })
   *
   * // 使用用户名密码认证
   * const client = new MinifluxClient({
   *   baseUrl: 'https://miniflux.example.org',
   *   username: 'admin',
   *   password: 'secret'
   * })
   * ```
   */
  constructor(options: MinifluxClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/$/, '')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (options.apiKey) {
      headers['X-Auth-Token'] = options.apiKey
    } else if (options.username && options.password) {
      const credentials = btoa(`${options.username}:${options.password}`)
      headers['Authorization'] = `Basic ${credentials}`
    } else {
      throw new MinifluxError('必须提供 API Key 或用户名密码')
    }

    this.fetch = ofetch.create({
      baseURL: `${baseUrl}/v1`,
      headers,
      responseType: 'json',
      onRequestError: ({ error }) => {
        const fetchError = error as FetchError<ErrorResponse>
        throw new MinifluxError(
          fetchError.data?.error_message || fetchError.message || '请求失败',
          fetchError.status,
          fetchError.data?.error_message
        )
      }
    })
  }

  /**
   * 发送 HTTP GET 请求
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    return this.fetch(endpoint, { method: 'GET', params })
  }

  /**
   * 发送 HTTP POST 请求
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async post<T>(endpoint: string, body?: any): Promise<T> {
    return this.fetch(endpoint, { method: 'POST', body })
  }

  /**
   * 发送 HTTP PUT 请求
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async put<T>(endpoint: string, body?: any): Promise<T> {
    return this.fetch(endpoint, { method: 'PUT', body })
  }

  /**
   * 发送 HTTP DELETE 请求
   */
  private async delete<T>(endpoint: string): Promise<T> {
    return this.fetch(endpoint, { method: 'DELETE' })
  }

  // ==================== 健康检查端点 ====================

  /**
   * 健康检查
   */
  async healthcheck(): Promise<void> {
    await this.get('/healthcheck')
  }

  /**
   * 存活检查
   */
  async liveness(): Promise<void> {
    await this.get('/healthcheck/liveness')
  }

  /**
   * 就绪检查
   */
  async readiness(): Promise<void> {
    await this.get('/healthcheck/readiness')
  }

  /**
   * 获取应用版本信息
   */
  async getVersion(): Promise<VersionInfo> {
    return this.get('/version')
  }

  // ==================== 发现订阅端点 ====================

  /**
   * 发现网站的 RSS/Atom 订阅
   */
  async discoverSubscriptions(request: DiscoverRequest): Promise<Subscription[]> {
    return this.post('/discover', request)
  }

  /**
   * 刷新历史记录
   */
  async flushHistory(): Promise<void> {
    await this.put('/flush-history')
  }

  // ==================== Feed 端点 ====================

  /**
   * 获取所有 Feed
   */
  async getFeeds(): Promise<Feed[]> {
    return this.get('/feeds')
  }

  /**
   * 获取指定 Feed
   */
  async getFeed(feedId: number): Promise<Feed> {
    return this.get(`/feeds/${feedId}`)
  }

  /**
   * 创建新 Feed
   */
  async createFeed(request: CreateFeedRequest): Promise<{ feed_id: number }> {
    return this.post('/feeds', request)
  }

  /**
   * 更新 Feed
   */
  async updateFeed(feedId: number, request: UpdateFeedRequest): Promise<Feed> {
    return this.put(`/feeds/${feedId}`, request)
  }

  /**
   * 刷新 Feed
   */
  async refreshFeed(feedId: number): Promise<void> {
    await this.put(`/feeds/${feedId}/refresh`)
  }

  /**
   * 刷新所有 Feed
   */
  async refreshAllFeeds(): Promise<void> {
    await this.put('/feeds/refresh')
  }

  /**
   * 删除 Feed
   */
  async removeFeed(feedId: number): Promise<void> {
    await this.delete(`/feeds/${feedId}`)
  }

  /**
   * 获取 Feed 图标
   */
  async getFeedIcon(feedId: number): Promise<Blob> {
    return this.get(`/feeds/${feedId}/icon`)
  }

  /**
   * 标记 Feed 的所有条目为已读
   */
  async markFeedEntriesAsRead(feedId: number): Promise<void> {
    await this.put(`/feeds/${feedId}/mark-all-as-read`)
  }

  // ==================== 条目端点 ====================

  /**
   * 获取条目列表
   */
  async getEntries(params?: EntriesRequest): Promise<{ total: number, entries: Entry[] }> {
    return this.get('/entries', params)
  }

  /**
   * 获取单个条目
   */
  async getEntry(entryId: number): Promise<Entry> {
    return this.get(`/entries/${entryId}`)
  }

  /**
   * 更新条目
   */
  async updateEntry(entryId: number, request: UpdateEntryRequest): Promise<Entry> {
    return this.put(`/entries/${entryId}`, request)
  }

  /**
   * 批量更新条目状态
   */
  async updateEntriesStatus(request: UpdateEntriesStatusRequest): Promise<void> {
    await this.put('/entries/status', request)
  }

  /**
   * 切换条目标记
   */
  async toggleEntryBookmark(entryId: number): Promise<void> {
    await this.put(`/entries/${entryId}/bookmark`)
  }

  /**
   * 获取原始文章
   */
  async fetchOriginalArticle(entryId: number): Promise<{ content: string }> {
    return this.get(`/entries/${entryId}/fetch-content`)
  }

  /**
   * 保存条目到第三方服务
   */
  async saveEntryToThirdParty(entryId: number): Promise<void> {
    await this.post(`/entries/${entryId}/save`)
  }

  /**
   * 获取 Feed 条目
   */
  async getFeedEntries(feedId: number, params?: EntriesRequest): Promise<{ total: number, entries: Entry[] }> {
    return this.get(`/feeds/${feedId}/entries`, params)
  }

  // ==================== 附件端点 ====================

  /**
   * 获取附件
   */
  async getEnclosure(enclosureId: number): Promise<Enclosure> {
    return this.get(`/enclosures/${enclosureId}`)
  }

  /**
   * 更新附件
   */
  async updateEnclosure(enclosureId: number, request: UpdateEnclosureRequest): Promise<Enclosure> {
    return this.put(`/enclosures/${enclosureId}`, request)
  }

  // ==================== 分类端点 ====================

  /**
   * 获取所有分类
   */
  async getCategories(): Promise<Category[]> {
    return this.get('/categories')
  }

  /**
   * 创建分类
   */
  async createCategory(request: CreateCategoryRequest): Promise<Category> {
    return this.post('/categories', request)
  }

  /**
   * 更新分类
   */
  async updateCategory(categoryId: number, request: UpdateCategoryRequest): Promise<Category> {
    return this.put(`/categories/${categoryId}`, request)
  }

  /**
   * 删除分类
   */
  async deleteCategory(categoryId: number): Promise<void> {
    await this.delete(`/categories/${categoryId}`)
  }

  /**
   * 获取分类的所有 Feed
   */
  async getCategoryFeeds(categoryId: number): Promise<Feed[]> {
    return this.get(`/categories/${categoryId}/feeds`)
  }

  /**
   * 获取分类条目
   */
  async getCategoryEntries(categoryId: number, params?: EntriesRequest): Promise<{ total: number, entries: Entry[] }> {
    return this.get(`/categories/${categoryId}/entries`, params)
  }

  /**
   * 刷新分类的所有 Feed
   */
  async refreshCategoryFeeds(categoryId: number): Promise<void> {
    await this.put(`/categories/${categoryId}/refresh`)
  }

  /**
   * 标记分类的所有条目为已读
   */
  async markCategoryEntriesAsRead(categoryId: number): Promise<void> {
    await this.put(`/categories/${categoryId}/mark-all-as-read`)
  }

  // ==================== 用户端点 ====================

  /**
   * 获取当前用户
   */
  async getCurrentUser(): Promise<User> {
    return this.get('/me')
  }

  /**
   * 获取所有用户（仅管理员）
   */
  async getUsers(): Promise<User[]> {
    return this.get('/users')
  }

  /**
   * 获取指定用户（仅管理员）
   */
  async getUser(userId: number): Promise<User> {
    return this.get(`/users/${userId}`)
  }

  /**
   * 创建用户（仅管理员）
   */
  async createUser(request: CreateUserRequest): Promise<User> {
    return this.post('/users', request)
  }

  /**
   * 更新用户
   */
  async updateUser(userId: number, request: UpdateUserRequest): Promise<User> {
    return this.put(`/users/${userId}`, request)
  }

  /**
   * 删除用户（仅管理员）
   */
  async deleteUser(userId: number): Promise<void> {
    await this.delete(`/users/${userId}`)
  }

  /**
   * 标记用户的所有条目为已读
   */
  async markUserEntriesAsRead(): Promise<void> {
    await this.put('/users/mark-all-as-read')
  }

  /**
   * 获取未读和已读计数
   */
  async getUnreadReadCounters(): Promise<UnreadReadCounters> {
    return this.get('/counters')
  }

  // ==================== API Key 端点 ====================

  /**
   * 获取所有 API Key
   */
  async getAPIKeys(): Promise<APIKey[]> {
    return this.get('/api-keys')
  }

  /**
   * 创建 API Key
   */
  async createAPIKey(request: CreateAPIKeyRequest): Promise<APIKey> {
    return this.post('/api-keys', request)
  }

  /**
   * 删除 API Key
   */
  async deleteAPIKey(keyId: number): Promise<void> {
    await this.delete(`/api-keys/${keyId}`)
  }

  // ==================== 集成状态端点 ====================

  /**
   * 获取集成状态
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getIntegrationsStatus(): Promise<Record<string, any>> {
    return this.get('/integrations')
  }

  // ==================== OPML 端点 ====================

  /**
   * 导出 OPML
   */
  async exportOPML(): Promise<string> {
    return this.get('/export')
  }

  /**
   * 导入 OPML
   */
  async importOPML(opmlContent: string): Promise<void> {
    await this.post('/import', opmlContent)
  }
}
