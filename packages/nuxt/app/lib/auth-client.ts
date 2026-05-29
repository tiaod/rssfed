import { createAuthClient } from "better-auth/vue"

export const authClient = createAuthClient({
  baseURL: useRuntimeConfig().public.apiBaseUrl,
})

export const { signIn, signUp, signOut, useSession } = authClient
