// 统一 API 请求：跨源访问 Hono 后端时必须携带会话 Cookie（ofetch 默认 same-origin）
import type { AdminFeed, FeedSubscriptionItem, RssFeed } from '~/types/rss'
import type {
  AttachedFeed,
  BotCreateBody,
  BotInfo,
  BotUpdateBody,
  FollowingItem,
  PublicBot,
  TimelineItem
} from '~/types/bot'
import type { SiteSettingsPublic, SiteSettingsFull, SiteSettingsUpdate } from '~/types/site'
import type { McpToken, McpTokenCreated } from '~/types/mcp'
import type { TimelineSettings as TimelineSettingsPayload } from '~/utils/timelineSettings'
import { resolveApiBase } from '~/utils/apiBase'

/** 催促聚合的响应（POST /api/timeline/refresh） */
export interface TimelineRefreshResult {
  /** 是否已受理（永远为 true；服务端拒绝的情况走 HTTP 错误） */
  accepted: boolean
  /** 服务端是否在本请求内跑完了聚合（未带 wait 时为 undefined） */
  completed?: boolean
  /** 本轮写入派生库的新条目数（仅 completed 时有意义） */
  added?: number
  /** 该用户的订阅源总数 */
  sources?: number
}

function apiFetch<T>(url: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  return $fetch<T>(url, { credentials: 'include', ...options })
}

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = resolveApiBase(apiBaseUrl)

  return {
    feeds: {
      discover: (url: string) => apiFetch<{ feedId: string, title?: string, items: number }>(
        `${base}/api/feeds/discover`,
        { method: 'POST', body: { url } }
      ),
      get: (id: string) => apiFetch<RssFeed>(`${base}/api/feeds/${id}`),
      subscriptions: () => apiFetch<FeedSubscriptionItem[]>(`${base}/api/feeds/subscriptions`),
      /** 管理员：获取全部 feed 注册表 */
      listAll: () => apiFetch<AdminFeed[]>(`${base}/api/feeds`),
      /** 管理员：暂停/恢复抓取 */
      updateStatus: (id: string, status: 'active' | 'paused') =>
        apiFetch(`${base}/api/feeds/${id}`, { method: 'PATCH', body: { status } }),
      /** 管理员：修改订阅源信息（含 per-feed 图片缓存策略；数值传 null 表示重置回全局默认） */
      update: (id: string, body: Partial<{
        title: string
        url: string
        description: string
        siteUrl: string
        image: string
        cacheImages: boolean
        maxImageCount: number | null
        maxEntryImageBytes: number | null
        maxImageWidth: number | null
        avifQuality: number | null
        maxSourceImageBytes: number | null
      }>) =>
        apiFetch(`${base}/api/feeds/${id}`, { method: 'PUT', body }),
      /** 管理员：触发重新抓取 */
      refetch: (id: string) => apiFetch(`${base}/api/feeds/${id}/refetch`, { method: 'POST' }),
      /** 管理员：获取全局默认图片缓存参数（供输入框 placeholder 展示默认值） */
      imageDefaults: () => apiFetch<{ maxImageCount: number, maxEntryImageBytes: number, maxImageWidth: number, avifQuality: number, maxSourceImageBytes: number }>(
        `${base}/api/feeds/image-defaults`
      ),
      /** 导入 OPML：批量注册订阅源并创建订阅，返回导入汇总 */
      importOpml: (opml: string) => apiFetch<{ total: number, imported: number, skipped: number, failed: { url: string, error: string }[] }>(
        `${base}/api/feeds/import-opml`,
        { method: 'POST', body: { opml } }
      )
    },
    /**
     * 服务端时间线聚合（每用户一个派生库）。
     *
     * 条目本身走 CouchDB 的 live 复制，不经这些接口；它们只负责设置与「催一次聚合」。
     */
    timeline: {
      /** 读取当前设置（顺带下发服务端默认值与合法区间） */
      settings: () => apiFetch<{ settings: TimelineSettingsPayload, defaults: TimelineSettingsPayload, limits: Record<string, { min: number, max: number }> }>(
        `${base}/api/timeline/settings`
      ),
      /** 更新设置；改图片参数时服务端会入队一次重建（rebuildQueued=true） */
      updateSettings: (body: Partial<TimelineSettingsPayload>) => apiFetch<{ settings: TimelineSettingsPayload, rebuildQueued: boolean }>(
        `${base}/api/timeline/settings`,
        { method: 'PATCH', body }
      ),
      /**
       * 催一次聚合（订阅/退订/打开列表/手动同步时调用）。
       *
       * `wait: 1` 时服务端会在本请求内跑完一轮 reconcile 再返回（有服务端超时上限），
       * 于是手动同步能拿到确切的「本轮新增 N 条」；不传则立即 202，数据靠 live 复制到端。
       */
      refresh: (params?: { wait?: 1 }) => apiFetch<TimelineRefreshResult>(
        `${base}/api/timeline/refresh`,
        { method: 'POST', params }
      ),
      /** 重建派生库（设置页的「重建时间线」） */
      rebuild: () => apiFetch<{ accepted: boolean }>(`${base}/api/timeline/rebuild`, { method: 'POST' })
    },
    bots: {
      list: () => apiFetch<BotInfo[]>(`${base}/api/bots`),
      /** 公开 Bot 列表（广场页）：所有启用状态的 bot 元数据 */
      public: () => apiFetch<PublicBot[]>(`${base}/api/bots/public`),
      create: (body: BotCreateBody) => apiFetch(`${base}/api/bots`, { method: 'POST', body }),
      update: (id: string, body: BotUpdateBody) => apiFetch(`${base}/api/bots/${id}`, { method: 'PUT', body }),
      remove: (id: string) => apiFetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
      /** 上传 Bot 头像（multipart），返回 { avatarUrl } */
      uploadAvatar: (id: string, file: File) => {
        const form = new FormData()
        form.append('file', file)
        return apiFetch<{ avatarUrl: string }>(`${base}/api/bots/${id}/avatar`, { method: 'POST', body: form })
      },
      feeds: (id: string) => apiFetch<AttachedFeed[]>(`${base}/api/bots/${id}/feeds`),
      attachFeed: (id: string, feedId: string) =>
        apiFetch(`${base}/api/bots/${id}/feeds`, { method: 'POST', body: { feedId } }),
      detachFeed: (id: string, feedId: string) =>
        apiFetch(`${base}/api/bots/${id}/feeds/${feedId}`, { method: 'DELETE' }),
      outbox: (id: string, params?: { limit?: number, offset?: number }) =>
        apiFetch(`${base}/api/bots/${id}/outbox`, { params }),
      follow: (id: string, handle: string) =>
        apiFetch(`${base}/api/bots/${id}/follow`, { method: 'POST', body: { handle } }),
      unfollow: (id: string, handle: string) =>
        apiFetch(`${base}/api/bots/${id}/unfollow`, { method: 'POST', body: { handle } }),
      following: (id: string) => apiFetch<FollowingItem[]>(`${base}/api/bots/${id}/following`),
      timeline: (id: string, params?: { limit?: number, offset?: number }) =>
        apiFetch<TimelineItem[]>(`${base}/api/bots/${id}/timeline`, { params })
    },
    user: {
      /** 上传当前用户头像（multipart），返回 { avatarUrl } */
      uploadAvatar: (file: File) => {
        const form = new FormData()
        form.append('file', file)
        return apiFetch<{ avatarUrl: string }>(`${base}/api/user/avatar`, { method: 'POST', body: form })
      }
    },
    /** 用户个人 API token：供 MCP 客户端以 Bearer 认证调用 /mcp 端点 */
    tokens: {
      /** 列出当前用户的 token 元数据（不含明文/token） */
      list: () => apiFetch<McpToken[]>(`${base}/api/user/tokens`),
      /** 生成一个新 token，明文只在本次返回（需一次性保存） */
      create: (body: { name?: string, expiresInDays?: number }) =>
        apiFetch<McpTokenCreated>(`${base}/api/user/tokens`, { method: 'POST', body }),
      /** 删除某个 token（物理删除，删除后立即失效） */
      remove: (id: string) => apiFetch(`${base}/api/user/tokens/${id}`, { method: 'DELETE' })
    },
    /** 站点品牌配置（公开读取，免登录；离线可由 Service Worker 缓存命中） */
    siteSettings: {
      get: () => apiFetch<SiteSettingsPublic>(`${base}/api/site-settings`)
    },
    /** 管理员：站点品牌/外观定制 */
    admin: {
      siteSettings: {
        get: () => apiFetch<SiteSettingsFull>(`${base}/api/admin/site-settings`),
        update: (body: Partial<SiteSettingsUpdate>) =>
          apiFetch<SiteSettingsFull>(`${base}/api/admin/site-settings`, { method: 'PUT', body }),
        /** 上传站点 logo（multipart），返回 { logoUrl } */
        uploadLogo: (file: File) => {
          const form = new FormData()
          form.append('file', file)
          return apiFetch<{ logoUrl: string }>(`${base}/api/admin/site-settings/logo`, { method: 'POST', body: form })
        },
        deleteLogo: () => apiFetch(`${base}/api/admin/site-settings/logo`, { method: 'DELETE' }),
        /**
         * 上传 PWA 方形图标（multipart），返回 { pwaIconUrl }。
         * 与站点 logo 分开：logo 多为横版（页头用），直接裁方会变形或切字。
         */
        uploadIcon: (file: File) => {
          const form = new FormData()
          form.append('file', file)
          return apiFetch<{ pwaIconUrl: string }>(`${base}/api/admin/site-settings/icon`, { method: 'POST', body: form })
        },
        deleteIcon: () => apiFetch(`${base}/api/admin/site-settings/icon`, { method: 'DELETE' })
      }
    }
  }
}
