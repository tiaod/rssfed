/**
 * 会话镜像的 Nuxt state key（plugins/auth-session.ts 写入，stores/user.ts 读取），
 * 以及「当前是哪个账号」这个判断本身。
 *
 * 单独放在 utils 里而不是从 store 导出：需要按账号隔离的应用级缓存
 * （列表快照，见 composables/useSyncedEntryList、utils/readingMark）也要问这个问题，
 * 而插件不该为了一个字符串去 import 整个 store 模块。
 */
export const SESSION_USER_STATE_KEY = 'auth-session-user'

/**
 * 当前账号 id；未登录与没有 Nuxt 上下文（单测）都返回 null。
 * 调用方据此丢弃不属于当前账号的缓存，避免把上一个账号的数据摆给用户。
 */
export function currentAccountId(): string | null {
  try {
    return useState<{ id?: string } | null>(SESSION_USER_STATE_KEY, () => null).value?.id ?? null
  } catch {
    return null
  }
}
