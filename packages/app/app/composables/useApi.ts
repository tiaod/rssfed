import type { RssFeed, RssEntry, RssCategory } from '~/types/rss'

export function useApi() {
  const fetchFn = import.meta.server ? useRequestFetch() : $fetch

  return {
    feeds: {
      discover: (url: string) => fetchFn<RssFeed>('/api/feeds/discover', { method: 'POST', body: { url } }),
      get: (id: string) => fetchFn<RssFeed>(`/api/feeds/${id}`),
    },
    subscriptions: {
      list: () => fetchFn<RssFeed[]>('/api/subscriptions'),
      create: (feedId: string) => fetchFn('/api/subscriptions', { method: 'POST', body: { feedId } }),
      remove: (feedId: string) => fetchFn('/api/subscriptions', { method: 'DELETE', body: { feedId } }),
    },
    entries: {
      list: (params?: { limit?: number; feedId?: string }) => fetchFn<RssEntry[]>('/api/entries', { params }),
      get: (id: string) => fetchFn<RssEntry>(`/api/entries/${id}`),
    },
    sync: {
      trigger: (feedIds: string[]) => fetchFn('/api/sync', { method: 'POST', body: { feedIds } }),
      status: () => fetchFn('/api/sync/status'),
    },
    bots: {
      list: () => fetchFn<any[]>('/api/bots'),
      create: (body: any) => fetchFn('/api/bots', { method: 'POST', body }),
      remove: (id: string) => fetchFn(`/api/bots/${id}`, { method: 'DELETE' }),
    },
  }
}
