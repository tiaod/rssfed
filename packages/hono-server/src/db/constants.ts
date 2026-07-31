export enum FeedViewType {
  All = 0,
  Articles = 1,
  SocialMedia = 2,
  Pictures = 3,
  Videos = 4,
  Audios = 5,
  Notifications = 6,
}

export const COUCHDB_FEED_PREFIX = "feed:"
export const COUCHDB_USER_STATE_PREFIX = "user-state:"
export const CLEANUP_DAYS = 30