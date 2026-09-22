// better-auth 会话相关的类型定义

/** 前端渲染用到的会话用户字段（better-auth 返回的 user 的超集子集） */
export interface SessionUser {
  id?: string
  name?: string
  email?: string
  image?: string | null
  role?: string | null
}
