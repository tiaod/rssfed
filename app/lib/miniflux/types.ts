export interface ErrorResponse {
  error_message: string
}

export interface Subscription {
  url: string
  title: string
  type: string
}

export interface DiscoverRequest {
  url: string
  username?: string
  password?: string
  user_agent?: string
  fetch_via_proxy?: boolean
}

export interface Feed {
  id: number
  user_id: number
  title: string
  site_url: string
  feed_url: string
  checked_at: string
  etag_header: string
  last_modified_header: string
  parsing_error_message: string
  parsing_error_count: number
  scraper_rules: string
  rewrite_rules: string
  crawler: boolean
  blocklist_rules: string
  keeplist_rules: string
  user_agent: string
  username: string
  password: string
  disabled: boolean
  ignore_http_cache: boolean
  fetch_via_proxy: boolean
  category_id?: number
}

export interface CreateFeedRequest {
  feed_url: string
  category_id?: number
  crawler?: boolean
  user_agent?: string
  username?: string
  password?: string
  scraper_rules?: string
  rewrite_rules?: string
  blocklist_rules?: string
  keeplist_rules?: string
  disabled?: boolean
  ignore_http_cache?: boolean
  fetch_via_proxy?: boolean
}

export interface UpdateFeedRequest {
  title?: string
  site_url?: string
  feed_url?: string
  category_id?: number
  crawler?: boolean
  user_agent?: string
  username?: string
  password?: string
  scraper_rules?: string
  rewrite_rules?: string
  blocklist_rules?: string
  keeplist_rules?: string
  disabled?: boolean
  ignore_http_cache?: boolean
  fetch_via_proxy?: boolean
}

export interface Entry {
  id: number
  user_id: number
  feed_id: number
  status: 'unread' | 'read' | 'removed'
  title: string
  url: string
  comments_url: string
  author: string
  content: string
  summary: string
  published_at: string
  created_at: string
  changed_at: string
  starred: boolean
  reading_time: number
  feed: Feed
  enclosures?: Enclosure[]
  tags?: string[]
}

export interface EntriesRequest {
  status?: 'unread' | 'read' | 'removed'
  starred?: boolean
  before?: number
  after?: number
  before_entry_id?: number
  after_entry_id?: number
  limit?: number
  offset?: number
  order?: 'id' | 'status' | 'published_at' | 'created_at' | 'changed_at'
  direction?: 'asc' | 'desc'
}

export interface UpdateEntryRequest {
  title?: string
  content?: string
}

export interface UpdateEntriesStatusRequest {
  entry_ids: number[]
  status: 'unread' | 'read' | 'removed'
}

export interface Enclosure {
  id: number
  user_id: number
  entry_id: number
  url: string
  size: number
  mime_type: string
  media_progression: number
}

export interface UpdateEnclosureRequest {
  media_progression: number
}

export interface Category {
  id: number
  title: string
  user_id: number
  hide_globally: boolean
}

export interface CreateCategoryRequest {
  title: string
  hide_globally?: boolean
}

export interface UpdateCategoryRequest {
  title?: string
  hide_globally?: boolean
}

export interface User {
  id: number
  username: string
  is_admin: boolean
  theme: string
  language: string
  timezone: string
  entry_sorting_direction: string
  entry_sorting: string
  entries_per_page: number
  keyboard_shortcuts: boolean
  show_reading_time: boolean
  entry_swipe: boolean
  stylesheet: string
  google_id: string
  openid_connect_id: string
  last_login_at: string
  two_factor_auth_enabled: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: Record<string, any>
}

export interface CreateUserRequest {
  username: string
  password: string
  is_admin?: boolean
}

export interface UpdateUserRequest {
  username?: string
  password?: string
  theme?: string
  language?: string
  timezone?: string
  entry_sorting_direction?: string
  entry_sorting?: string
  entries_per_page?: number
  keyboard_shortcuts?: boolean
  show_reading_time?: boolean
  entry_swipe?: boolean
  stylesheet?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>
}

export interface APIKey {
  id: number
  token: string
  user_id: number
  description: string
  last_used_at?: string
  created_at: string
}

export interface CreateAPIKeyRequest {
  description: string
}

export interface UnreadReadCounters {
  unread: number
  read: number
}

export interface VersionInfo {
  version: string
  build_date: string
  commit: string
}
