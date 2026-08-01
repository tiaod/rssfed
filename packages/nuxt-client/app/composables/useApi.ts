// 统一 API 请求：跨源访问 Hono 后端时必须携带会话 Cookie（ofetch 默认 same-origin）
function apiFetch<T>(url: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  return $fetch<T>(url, { credentials: 'include', ...options })
}

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')

  return {
    feeds: {
      discover: (url: string) => apiFetch<any>(`${base}/api/feeds/discover`, { method: 'POST', body: { url } }),
      get: (id: string) => apiFetch<any>(`${base}/api/feeds/${id}`)
    },
    bots: {
      list: () => apiFetch<any[]>(`${base}/api/bots`),
      create: (body: any) => apiFetch(`${base}/api/bots`, { method: 'POST', body }),
      remove: (id: string) => apiFetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
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
