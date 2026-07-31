export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')

  return {
    feeds: {
      discover: (url: string) => $fetch<any>(`${base}/api/feeds/discover`, { method: 'POST', body: { url } }),
      get: (id: string) => $fetch<any>(`${base}/api/feeds/${id}`),
    },
    bots: {
      list: () => $fetch<any[]>(`${base}/api/bots`),
      create: (body: any) => $fetch(`${base}/api/bots`, { method: 'POST', body }),
      remove: (id: string) => $fetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
      outbox: (id: string, params?: { limit?: number; offset?: number }) =>
        $fetch(`${base}/api/bots/${id}/outbox`, { params }),
    },
  }
}
