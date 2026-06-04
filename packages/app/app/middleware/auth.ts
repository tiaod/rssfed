export default defineNuxtRouteMiddleware(async (to) => {
  const { data: session } = await useAuthClient().useSession(useFetch)

  if (!session.value) {
    return navigateTo({ path: "/login", query: { redirect: to.fullPath } })
  }
})
