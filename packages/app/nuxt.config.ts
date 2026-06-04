// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@pinia/nuxt'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    fonts: false,
  },

  nitro: {
    routeRules: {
      // 注意：不要在这里添加 /api/** 的全局代理规则，
      // 否则会覆盖 @nuxt/icon 等模块的服务端路由。
      // 代理逻辑已由 server/middleware/api-proxy.ts 处理。
    },
  },

  runtimeConfig: {
    public: {
      authBaseUrl: '/api/auth',
      apiBaseUrl: 'http://localhost:3001',
    },
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
