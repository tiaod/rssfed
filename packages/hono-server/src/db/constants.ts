export enum FeedViewType {
  All = 0,
  Articles = 1,
  SocialMedia = 2,
  Pictures = 3,
  Videos = 4,
  Audios = 5,
  Notifications = 6,
}

export const COUCHDB_GLOBAL = "rssfed-global"
export const COUCHDB_USER_PREFIX = "rssfed-user:"
export const SYNC_BATCH_SIZE = 500
export const CLEANUP_DAYS = 30