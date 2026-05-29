import Dexie, { type EntityTable } from 'dexie'
import type { Entry } from '~/lib/miniflux/types'

export interface OfflineEntry extends Entry {
  cachedAt: number
}

const db = new Dexie('rssfed') as Dexie & {
  entries: EntityTable<OfflineEntry, 'id'>
}

db.version(1).stores({
  entries: 'id, feed_id, published_at, cachedAt'
})

export { db }
