export default defineNuxtRouteMiddleware(async (to) => {
  // 离线时直接放行：本地 PouchDB 里有条目与订阅，把人赶去登录页会让离线阅读彻底失效
  if (import.meta.client && !navigator.onLine) return

  const { data: session, error } = await useAuthClient().useSession(useFetch)

  // 会话请求本身失败（后端不可达、请求被中断）同样放行：
  // 真正的未登录会拿到 200 + null，不会走到这里。宁可让离线用本地数据，
  // 也不要因为后端抖动把已登录用户踢到登录页。
  if (error.value) return

  if (!session.value) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
