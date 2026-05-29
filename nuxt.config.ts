import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  modules: [
    '@pinia/nuxt',
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

  alias: {
    '~server': resolve(__dirname, 'server')
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

  typescript: {
    tsConfig: {
      compilerOptions: {
        paths: {
          '~server': [resolve(__dirname, 'server')],
          '~server/*': [resolve(__dirname, 'server/*')]
        }
      }
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
