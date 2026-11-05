/**
 * 会话镜像的 Nuxt state key（plugins/auth-session.ts 写入，stores/user.ts 读取）。
 *
 * 单独放在 utils 里而不是从 store 导出：插件不该为了一个字符串去 import 整个 store 模块。
 */
export const SESSION_USER_STATE_KEY = 'auth-session-user'

/**
 * SSR 会话预取的结论（plugins/auth-session.ts 写入，全局鉴权中间件读取）。
 *
 * 必须与「用户为空」区分开：后端不可达时用户也是空，但那时应该放行（离线仍可
 * 用本地数据），只有拿到 200 + null 才能断定是未登录并送去落地页。
 */
export const SESSION_CHECK_STATE_KEY = 'auth-session-check'

export type SessionCheckState = 'authenticated' | 'anonymous' | 'unknown'
