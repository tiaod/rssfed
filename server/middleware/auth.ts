import { auth } from '~/lib/auth'

type Session = typeof auth.$Infer.Session

declare module 'h3' {
  interface H3EventContext {
    session?: Session['session']
    user?: Session['user']
    isAuthenticated: boolean
  }
}

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({
    headers: event.headers
  })

  if (session) {
    event.context.session = session.session
    event.context.user = session.user
    event.context.isAuthenticated = true
  } else {
    event.context.isAuthenticated = false
  }
})
