import type { Feed, Entry, Category } from '~/lib/miniflux/types'

interface EntriesParams {
  limit?: number
  order?: string
  direction?: string
}

export function useApi() {
  const fetchFn = import.meta.server ? useRequestFetch() : $fetch

  return {
    siteSettings: {
      get: () => fetchFn<{ settings: Record<string, unknown> | null }>('/api/site-settings'),
      update: (body: Record<string, unknown>) => fetchFn('/api/site-settings', { method: 'PUT', body })
    },

    miniflux: {
      getFeeds: () => fetchFn<Feed[]>('/api/miniflux/feeds'),
      getFeed: (id: number) => fetchFn<Feed>(`/api/miniflux/feeds/${id}`),
      getCategories: () => fetchFn<Category[]>('/api/miniflux/categories'),
      getEntries: (parentType: 'feeds' | 'categories', parentId: number | string, params?: EntriesParams) => {
        return fetchFn<{ total: number, entries: Entry[] }>(`/api/miniflux/${parentType}/${parentId}/entries`, { params })
      },
      getEntry: (entryId: number) => fetchFn<Entry>(`/api/miniflux/entries/${entryId}`)
    }
  }
}
