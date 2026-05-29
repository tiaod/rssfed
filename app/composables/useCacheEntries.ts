import type { Entry } from '~/lib/miniflux/types'
import { db, type OfflineEntry } from '~/lib/db-client'

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

export function useCacheEntries() {
  async function saveEntry(entry: Entry): Promise<void> {
    const now = Date.now()
    const existing = await db.entries.get(entry.id)
    if (existing && existing.content === entry.content) return

    await db.entries.put({ ...entry, cachedAt: now })
  }

  async function saveEntries(entries: Entry[]): Promise<void> {
    const now = Date.now()
    await db.entries.bulkPut(
      entries.map(e => ({ ...e, cachedAt: now })),
      { allKeys: true }
    )
  }

  async function getEntry(entryId: number): Promise<Entry | undefined> {
    const cached = await db.entries.get(entryId)
    return cached
  }

  async function getEntries(params?: {
    limit?: number
    order?: 'asc' | 'desc'
    search?: string
  }): Promise<{ entries: Entry[], total: number }> {
    const limit = params?.limit ?? 50
    const direction = params?.order ?? 'desc'

    let collection = db.entries.orderBy('published_at')

    if (params?.search) {
      const q = params.search.toLowerCase()
      collection = collection.filter(
        e => e.title.toLowerCase().includes(q)
          || (e.author && e.author.toLowerCase().includes(q))
          || stripHtml(e.content).toLowerCase().includes(q)
      )
    }

    const total = await collection.count()
    const entries = await (direction === 'desc' ? collection.reverse() : collection)
      .limit(limit)
      .toArray()

    return { entries, total }
  }

  function isCached(entryId: number): Promise<OfflineEntry | undefined> {
    return db.entries.get(entryId)
  }

  async function clearAll(): Promise<void> {
    await db.entries.clear()
  }

  async function removeEntry(entryId: number): Promise<void> {
    await db.entries.delete(entryId)
  }

  return {
    saveEntry,
    saveEntries,
    getEntry,
    getEntries,
    isCached,
    clearAll,
    removeEntry
  }
}
