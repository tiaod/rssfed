export interface RssFeed {
  id: string
  title: string
  siteUrl: string
  feedUrl: string
  description?: string
  image?: string
  errorMessage?: string
  category?: RssCategory
  lastFetchedAt: string
}

export interface RssEntry {
  id: string
  feedId: string
  title: string
  url: string
  content?: string
  description?: string
  author?: string
  publishedAt: string
  insertedAt: string
  categories?: string[]
  feed: RssFeed
  starred: boolean
  read: boolean
  readingTime: number
  enclosures?: RssEnclosure[]
}

export interface RssEnclosure {
  url: string
  mimeType: string
  size: number
}

export interface RssCategory {
  id: string
  title: string
}
