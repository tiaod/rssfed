import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { auth } from '~/lib/auth'

export interface AuthUser {
  id: string
  email: string
  emailVerified: boolean
  name: string
  role?: string
  miniflux?: {
    minifluxUserId: number
    minifluxUsername: string
    minifluxApiKey: string
  } | null
}

export interface AuthSession {
  id: string
  expiresAt: Date
  token: string
  createdAt: Date
  updatedAt: Date
  ipAddress?: string
  userAgent?: string
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
    session: AuthSession
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers })
  if (result) {
    c.set('user', result.user as unknown as AuthUser)
    c.set('session', result.session as unknown as AuthSession)
  }
  await next()
})

export function requireAuth(c: Context): AuthUser {
  const user = c.get('user')
  if (!user) {
    throw new HTTPException(401, { message: '未登录' })
  }
  return user
}

export function requireAdmin(c: Context): AuthUser {
  const user = requireAuth(c)
  if (user.role !== 'admin') {
    throw new HTTPException(403, { message: 'Forbidden' })
  }
  return user
}

export function getOptionalUser(c: Context): AuthUser | undefined {
  return c.get('user')
}
