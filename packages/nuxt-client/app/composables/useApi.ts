// 统一 API 请求：跨源访问 Hono 后端时必须携带会话 Cookie（ofetch 默认 same-origin）
import type { FeedSubscriptionItem } from '~/types/rss'
import type { SiteSettingsPublic, SiteSettingsFull, SiteSettingsUpdate } from '~/types/site'
import { resolveApiBase } from '~/utils/apiBase'

function apiFetch<T>(url: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  return $fetch<T>(url, { credentials: 'include', ...options })
}

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = resolveApiBase(apiBaseUrl)

  return {
    feeds: {
      discover: (url: string) => apiFetch<any>(`${base}/api/feeds/discover`, { method: 'POST', body: { url } }),
      get: (id: string) => apiFetch<any>(`${base}/api/feeds/${id}`),
      subscriptions: () => apiFetch<FeedSubscriptionItem[]>(`${base}/api/feeds/subscriptions`),
      /** 管理员：获取全部 feed 注册表 */
      listAll: () => apiFetch<any[]>(`${base}/api/feeds`),
      /** 管理员：暂停/恢复抓取 */
      updateStatus: (id: string, status: 'active' | 'paused') =>
        apiFetch(`${base}/api/feeds/${id}`, { method: 'PATCH', body: { status } }),
      /** 管理员：修改订阅源信息（含 per-feed 图片缓存策略；数值传 null 表示重置回全局默认） */
      update: (id: string, body: Partial<{
        title: string, url: string, description: string, siteUrl: string, image: string,
        cacheImages: boolean,
        maxImageCount: number | null,
        maxImageWidth: number | null,
        avifQuality: number | null,
        maxSourceImageBytes: number | null,
      }>) =>
        apiFetch(`${base}/api/feeds/${id}`, { method: 'PUT', body }),
      /** 管理员：触发重新抓取 */
      refetch: (id: string) => apiFetch(`${base}/api/feeds/${id}/refetch`, { method: 'POST' }),
      /** 管理员：获取全局默认图片缓存参数（供输入框 placeholder 展示默认值） */
      imageDefaults: () => apiFetch<{ maxImageCount: number, maxImageWidth: number, avifQuality: number, maxSourceImageBytes: number }>(
        `${base}/api/feeds/image-defaults`
      ),
      /** 导入 OPML：批量注册订阅源并创建订阅，返回导入汇总 */
      importOpml: (opml: string) => apiFetch<{ total: number, imported: number, skipped: number, failed: { url: string, error: string }[] }>(
        `${base}/api/feeds/import-opml`,
        { method: 'POST', body: { opml } }
      )
    },
    bots: {
      list: () => apiFetch<any[]>(`${base}/api/bots`),
      /** 公开 Bot 列表（广场页）：所有启用状态的 bot 元数据 */
      public: () => apiFetch<any[]>(`${base}/api/bots/public`),
      create: (body: any) => apiFetch(`${base}/api/bots`, { method: 'POST', body }),
      update: (id: string, body: any) => apiFetch(`${base}/api/bots/${id}`, { method: 'PUT', body }),
      remove: (id: string) => apiFetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
      /** 上传 Bot 头像（multipart），返回 { avatarUrl } */
      uploadAvatar: (id: string, file: File) => {
        const form = new FormData()
        form.append('file', file)
        return apiFetch<{ avatarUrl: string }>(`${base}/api/bots/${id}/avatar`, { method: 'POST', body: form })
      },
      feeds: (id: string) => apiFetch<any[]>(`${base}/api/bots/${id}/feeds`),
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
      following: (id: string) => apiFetch<any[]>(`${base}/api/bots/${id}/following`),
      timeline: (id: string, params?: { limit?: number, offset?: number }) =>
        apiFetch<any[]>(`${base}/api/bots/${id}/timeline`, { params })
    },
    user: {
      /** 上传当前用户头像（multipart），返回 { avatarUrl } */
      uploadAvatar: (file: File) => {
        const form = new FormData()
        form.append('file', file)
        return apiFetch<{ avatarUrl: string }>(`${base}/api/user/avatar`, { method: 'POST', body: form })
      }
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
        deleteLogo: () => apiFetch(`${base}/api/admin/site-settings/logo`, { method: 'DELETE' })
      }
    }
  }
}
