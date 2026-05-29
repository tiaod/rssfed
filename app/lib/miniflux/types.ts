export interface FeedIcon {
  feed_id: number
  icon_id: number
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
  category?: Category
  icon?: FeedIcon
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
  hash: string
  published_at: string
  created_at: string
  changed_at: string
  share_code: string
  starred: boolean
  reading_time: number
  enclosures?: Enclosure[]
  feed: Feed
  tags?: string[]
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

export interface Category {
  id: number
  title: string
  user_id: number
  hide_globally: boolean
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
  extra: Record<string, unknown>
}

export interface CreateUserRequest {
  username: string
  password: string
  is_admin?: boolean
}

export interface APIKey {
  id: number
  token: string
  user_id: number
  description: string
  last_used_at?: string
  created_at: string
}
