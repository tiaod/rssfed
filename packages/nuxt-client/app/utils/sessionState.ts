/**
 * 会话镜像的 Nuxt state key（plugins/auth-session.ts 写入，stores/user.ts 读取）。
 *
 * 单独放在 utils 里而不是从 store 导出：插件不该为了一个字符串去 import 整个 store 模块。
 */
export const SESSION_USER_STATE_KEY = 'auth-session-user'
