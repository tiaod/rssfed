import type { RssFeed, RssEntry } from '~/types/rss'

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')

  return {
    feeds: {
      discover: (url: string) => $fetch<RssFeed>(`${base}/api/feeds/discover`, { method: 'POST', body: { url } }),
      get: (id: string) => $fetch<RssFeed>(`${base}/api/feeds/${id}`),
    },
    entries: {
      list: (params?: { limit?: number; feedId?: string }) => $fetch<RssEntry[]>(`${base}/api/entries`, { params }),
      get: (id: string) => $fetch<RssEntry>(`${base}/api/entries/${id}`),
    },
    sync: {
      trigger: (feedIds: string[]) => $fetch(`${base}/api/sync`, { method: 'POST', body: { feedIds } }),
      status: () => $fetch(`${base}/api/sync/status`),
    },
    bots: {
      list: () => $fetch<any[]>(`${base}/api/bots`),
      create: (body: any) => $fetch(`${base}/api/bots`, { method: 'POST', body }),
      remove: (id: string) => $fetch(`${base}/api/bots/${id}`, { method: 'DELETE' }),
    },
  }
}
