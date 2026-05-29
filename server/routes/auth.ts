import { Hono } from 'hono'
import { auth } from '~/lib/auth'

export default new Hono()
  .on(['GET', 'POST'], '/*', c => auth.handler(c.req.raw))
