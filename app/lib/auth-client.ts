import { createAuthClient } from 'better-auth/vue'
import { adminClient, organizationClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    organizationClient()
  ]
})
