// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    "@nuxt/eslint",
    "@nuxt/ui",
    "@vueuse/nuxt",
  ],

  devtools: {
    enabled: true,
  },

  css: ["~/assets/css/main.css"],

  runtimeConfig: {
    public: {
      apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
    },
  },

  nitro: {
    routeRules: {
      "/api/**": {
        proxy: process.env.API_BASE_URL ?? "http://localhost:3001",
      },
    },
  },

  compatibilityDate: "2024-07-11",

  eslint: {
    config: {
      stylistic: {
        commaDangle: "never",
        braceStyle: "1tbs",
      },
    },
  },
})
