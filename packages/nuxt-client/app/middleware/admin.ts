import { useUserStore } from '~/stores/user'

/**
 * 管理员页面守卫。
 *
 * 只拦「明确不是管理员」的已登录用户：会话未就绪 / 后端不可达（离线）时放行，
 * 由页面自己去请求管理接口并在失败时报错 —— 把可能的管理员一脚踢回首页，
 * 只会让「网络抖一下」看起来像「我的权限没了」。
 *
 * 未登录的情况不在这里处理：全局的 auth.global.ts 已经先一步送去落地页。
 */
export default defineNuxtRouteMiddleware(() => {
  const userStore = useUserStore()
  if (userStore.user && !userStore.isAdmin) {
    return navigateTo('/')
  }
})
