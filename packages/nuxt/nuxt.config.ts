import { defineNuxtConfig } from "nuxt/config"

export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  devtools: { enabled: true },
  compatibilityDate: "2026-05-27",

  runtimeConfig: {
    public: {
      apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3001",
      couchdbUrl: process.env.COUCHDB_URL ?? "http://localhost:5984",
    },
  },

  nitro: {
    routeRules: {
      "/api/**": { proxy: process.env.API_BASE_URL ?? "http://localhost:3001" },
    },
  },

  typescript: {
    strict: true,
  },
})