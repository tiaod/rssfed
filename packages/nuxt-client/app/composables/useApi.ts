// 统一 API 请求：跨源访问 Hono 后端时必须携带会话 Cookie（ofetch 默认 same-origin）
import type { FeedSubscriptionItem } from '~/types/rss'

function apiFetch<T>(url: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  return $fetch<T>(url, { credentials: 'include', ...options })
}

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')

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
      /** 管理员：修改订阅源信息 */
      update: (id: string, body: Partial<{ title: string, url: string, description: string, siteUrl: string, image: string }>) =>
        apiFetch(`${base}/api/feeds/${id}`, { method: 'PUT', body }),
      /** 管理员：触发重新抓取 */
      refetch: (id: string) => apiFetch(`${base}/api/feeds/${id}/refetch`, { method: 'POST' }),
      /** 导入 OPML：批量注册订阅源并创建订阅，返回导入汇总 */
      importOpml: (opml: string) => apiFetch<{ total: number, imported: number, skipped: number, failed: { url: string, error: string }[] }>(
        `${base}/api/feeds/import-opml`,
        { method: 'POST', body: { opml } }
      )
    },
    bots: {
      list: () => apiFetch<any[]>(`${base}/api/bots`),
      create: (body: any) => apiFetch(`${base}/api/bots`, { method: 'POST', body }),
      update: (id: string, body: any) => apiFetch(`${base}/api/bots/${id}`, { method: 'PUT', body }),
      remove: (id: string) => apiFetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
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
    }
  }
}
