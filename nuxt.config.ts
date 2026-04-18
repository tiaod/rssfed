// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    process.env.NODE_ENV === 'test' ? '@nuxt/test-utils/module' : null
  ].filter(Boolean),

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    fonts: false
  },

  routeRules: {
    '/': { prerender: true },
    '/@vite/**': { ssr: false }
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    storage: {
      redis: {
        driver: 'redis',
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      }
    }
  },
  vite: {
    optimizeDeps: {
      include: [
        'better-auth/vue'
      ]
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
