// https://nuxt.com/docs/api/configuration/nuxt-config
import { generateServiceWorkerManifest } from './build/generate-sw-manifest'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@pinia/nuxt',
    '@vueuse/nuxt'
  ],

  // 监听 0.0.0.0，方便局域网（手机）访问开发服务器
  devServer: {
    host: '0.0.0.0',
  },

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    fonts: false,
  },

  // 离线优先：把图标数据随客户端 bundle 一起下发（编译期内联进 JS，不是运行时再发请求）。
  // 客户端 loadIcon() 会先 initClientBundle(addIcon) 注册本地数据，命中后就不访问
  // /api/_nuxt_icon —— 断网可用，也不再依赖反代放行该路径。
  icon: {
    clientBundle: {
      // 扫描源码里写死的 i-lucide-xxx（去重后约 70 个，未压缩 20KB 左右）
      scan: true,
      // Nuxt UI 组件内部的默认图标不写在项目源码里，scan 也扫不到
      // （默认排除 node_modules，且只收 .vue/.ts 等后缀，收不到 @nuxt/ui 的 dist/*.mjs），
      // 必须显式列出，否则模态框关闭、主题切换、下拉箭头这类图标在离线时会空白。
      // 清单取自 @nuxt/ui 的默认 ui.icons 表；与扫描结果重复的部分内部用 Set 去重，不额外占体积。
      icons: [
        'lucide:arrow-down',
        'lucide:arrow-left',
        'lucide:arrow-right',
        'lucide:arrow-up',
        'lucide:arrow-up-right',
        'lucide:check',
        'lucide:chevron-down',
        'lucide:chevron-left',
        'lucide:chevron-right',
        'lucide:chevron-up',
        'lucide:chevrons-left',
        'lucide:chevrons-right',
        'lucide:circle-alert',
        'lucide:circle-check',
        'lucide:circle-x',
        'lucide:copy',
        'lucide:copy-check',
        'lucide:ellipsis',
        'lucide:eye',
        'lucide:eye-off',
        'lucide:file',
        'lucide:folder',
        'lucide:folder-open',
        'lucide:grip-vertical',
        'lucide:hash',
        'lucide:info',
        'lucide:lightbulb',
        'lucide:loader-circle',
        'lucide:menu',
        'lucide:minus',
        'lucide:monitor',
        'lucide:moon',
        'lucide:panel-left-close',
        'lucide:panel-left-open',
        'lucide:plus',
        'lucide:rotate-ccw',
        'lucide:search',
        'lucide:square',
        'lucide:sun',
        'lucide:terminal',
        'lucide:triangle-alert',
        'lucide:upload',
        'lucide:x'
      ]
    }
  },

  nitro: {
    // 离线外壳预渲染成静态 HTML：Service Worker 在断网且没有同路径缓存时返回它
    // （见 public/sw.js 与 app/pages/offline.vue）
    prerender: {
      routes: ['/offline']
    },
    routeRules: {
      // 注意：不要在这里添加 /api/** 的全局代理规则，
      // 否则会覆盖 @nuxt/icon 等模块的服务端路由。
      // 生产反代同理：/api/_nuxt_icon/* 必须留在 Nuxt 上，不能跟着 /api/* 转给后端，
      // 否则线上图标整片空白（见 deploy/Caddyfile 与 docs/troubleshooting.md）。
    },
  },

  hooks: {
    // 静态资源都落到 .output/public 之后，生成 SW 的预缓存清单并把构建号写进 sw.js
    'nitro:build:public-assets': async (nitro) => {
      const { version, count } = await generateServiceWorkerManifest(nitro.options.output.publicDir)
      console.log(`[sw] 预缓存清单已生成：${count} 个资源，版本 ${version}`)
    }
  },

  runtimeConfig: {
    public: {
      // better-auth 直连 Hono 后端（同源 Cookie 由 CORS + credentials 处理）
      authBaseUrl: 'http://localhost:3001/api/auth',
      // Hono 后端地址，前端直连
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
