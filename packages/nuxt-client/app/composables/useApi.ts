// 统一 API 请求：跨源访问 Hono 后端时必须携带会话 Cookie（ofetch 默认 same-origin）
import type { FeedSubscriptionItem, RssFeed } from '~/types/rss'
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
import type { TimelineLogPayload } from '~/types/timeline-log'
import type { TimelineSettings as TimelineSettingsPayload } from '~/utils/timelineSettings'
import { resolveApiBase } from '~/utils/apiBase'
import { importOpmlStreaming, type OpmlImportEvent } from '~/utils/opmlImport'

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
      /**
       * 解析并校验一个源（**不写订阅**）。
       *
       * 返回的 `url` 要原样写进订阅文档 —— 服务端抓取靠它（feedId 是 url 的哈希，不可逆）。
       */
      discover: (url: string) => apiFetch<{
        feedId: string
        url: string
        title?: string
        siteUrl?: string
        description?: string
        image?: string
        items: number
      }>(
        `${base}/api/feeds/discover`,
        { method: 'POST', body: { url } }
      ),
      get: (id: string) => apiFetch<RssFeed>(`${base}/api/feeds/${id}`),
      subscriptions: () => apiFetch<FeedSubscriptionItem[]>(`${base}/api/feeds/subscriptions`),
      /** 订阅一个源（写订阅文档 + 触发首抓）。已订阅时 added=false */
      subscribe: (url: string, category?: string) => apiFetch<{
        feedId: string
        url: string
        title: string
        added: boolean
      }>(`${base}/api/feeds/subscriptions`, { method: 'POST', body: { url, category } }),
      /** 退订（同时清掉该源已抓到的条目） */
      unsubscribe: (feedId: string) => apiFetch<{ ok: true, removedEntries?: number }>(
        `${base}/api/feeds/subscriptions/${encodeURIComponent(feedId)}`,
        { method: 'DELETE' }
      ),
      /** 改一条订阅（仅显示名与分组；换源请重新订阅） */
      updateSubscription: (feedId: string, body: { title?: string, category?: string }) =>
        apiFetch<{ ok: true }>(
          `${base}/api/feeds/subscriptions/${encodeURIComponent(feedId)}`,
          { method: 'PATCH', body }
        ),
      /** 暂停/恢复一条订阅的抓取（保留已抓到的内容） */
      setSubscriptionPaused: (feedId: string, paused: boolean) =>
        apiFetch<{ ok: true, paused: boolean }>(
          `${base}/api/feeds/subscriptions/${encodeURIComponent(feedId)}/${paused ? 'pause' : 'resume'}`,
          { method: 'POST' }
        ),
      /**
       * 订阅一个 Bot 之后，把它已有的产出立刻搬进用户库。
       *
       * 客户端写订阅文档是纯本地操作（离线也能做），所以「搬内容」只能由服务端补 ——
       * 不调用这一步的话要等下一个 Bot 产出周期才看到东西（可能几小时）。
       * 幂等：已搬过的条目按 `_id` 跳过，重复调用只多一次查询。
       */
      syncBotSubscription: (botId: string) => apiFetch<{ ok: true, copied: number, scanned: number }>(
        `${base}/api/feeds/bot-subscriptions/${encodeURIComponent(botId)}/sync`,
        { method: 'POST' }
      ),
      /** 立即重新抓取一条订阅（清空失败计数并绕开抓取缓存） */
      refetchSubscription: (feedId: string) => apiFetch<{ ok: true, queued: boolean }>(
        `${base}/api/feeds/subscriptions/${encodeURIComponent(feedId)}/refetch`,
        { method: 'POST' }
      ),
      /**
       * 导入 OPML：批量注册订阅源并创建订阅。
       *
       * 这是个流式接口（后端逐源推 NDJSON 进度事件，见 utils/opmlImport.ts），
       * 因此不走 $fetch —— 它要等流结束才返回，进度就没了。
       */
      importOpml: (opml: string, options: { onEvent?: (event: OpmlImportEvent) => void, signal?: AbortSignal } = {}) =>
        importOpmlStreaming(`${base}/api/feeds/import-opml`, opml, options)
    },
    /**
     * 服务端时间线聚合（每用户一个派生库）。
     *
     * 条目本身走 CouchDB 的 live 复制，不经这些接口；它们只负责设置与「催一次聚合」。
     */
    timeline: {
      /** 读取当前设置（顺带下发服务端默认值） */
      settings: () => apiFetch<{ settings: TimelineSettingsPayload, defaults: TimelineSettingsPayload }>(
        `${base}/api/timeline/settings`
      ),
      /** 更新设置（只影响「往用户库里聚合什么」，服务端会顺手催一次聚合） */
      updateSettings: (body: Partial<TimelineSettingsPayload>) => apiFetch<{ settings: TimelineSettingsPayload }>(
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
      /** 重建派生库（运维兜底入口，见 useTimelineSettings.rebuild） */
      rebuild: () => apiFetch<{ accepted: boolean }>(`${base}/api/timeline/rebuild`, { method: 'POST' }),
      /**
       * 同步日志（设置弹窗 → 数据 →「同步日志」调试面板）。
       *
       * 返回两段：`events` = 服务端落下的流水（汇聚/重建/首搬/失败），
       * `sources` = 每个订阅源的当前同步状态（读水位表，不是流水）。
       */
      events: (limit?: number) => apiFetch<TimelineLogPayload>(
        `${base}/api/timeline/events`,
        { params: limit ? { limit } : undefined }
      ),
      /** 清空流水（源状态不受影响） */
      clearEvents: () => apiFetch<{ ok: boolean }>(`${base}/api/timeline/events`, { method: 'DELETE' })
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
      /** options 目前只用于 SSR 预取时限制超时（见 plugins/site-settings.server.ts） */
      get: (options: { timeout?: number } = {}) =>
        apiFetch<SiteSettingsPublic>(`${base}/api/site-settings`, options)
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
        /** 上传深色模式专用站点 logo（multipart），返回 { logoDarkUrl } */
        uploadLogoDark: (file: File) => {
          const form = new FormData()
          form.append('file', file)
          return apiFetch<{ logoDarkUrl: string }>(`${base}/api/admin/site-settings/logo-dark`, { method: 'POST', body: form })
        },
        deleteLogoDark: () => apiFetch(`${base}/api/admin/site-settings/logo-dark`, { method: 'DELETE' }),
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
