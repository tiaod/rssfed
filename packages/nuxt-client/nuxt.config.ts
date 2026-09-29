// https://nuxt.com/docs/api/configuration/nuxt-config
import { generateServiceWorkerManifest } from './build/generate-sw-manifest'

/**
 * 只有开发环境需要把 /api/site-settings/** 代理到后端（见下方 routeRules）：
 * dev 前后端分端口，而 PWA 的 manifest 与图标必须同源。
 *
 * 判据是 NODE_ENV，且这个保证来自 nuxi 本身而不是 Dockerfile：`nuxi build` 会在加载
 * 本配置**之前**强制 `process.env.NODE_ENV = 'production'`（`nuxi dev` 则设 development，
 * 见 @nuxt/cli 的 overrideEnv），所以这条规则不会进入生产构建 —— 生产由 Caddy 把
 * /api/* 分流到 Hono，请求到不了 Nuxt，规则留着只会在「直连 web 容器排障」时表现为
 * 难以理解的 502。故构建镜像无需额外声明 NODE_ENV。
 *
 * 但若将来绕过 nuxi 改用编程式构建（@nuxt/kit 的 loadNuxt + build），NODE_ENV 不再被
 * 强制设置，需自行保证为 production，否则这条代理规则会被打进生产产物。
 */
const isDev = process.env.NODE_ENV !== 'production'
/** 后端地址：与 runtimeConfig.public.apiBaseUrl 的默认值保持一致 */
const backendBaseUrl = process.env.NUXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@pinia/nuxt',
    '@vueuse/nuxt'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    fonts: false
  },

  runtimeConfig: {
    public: {
      // better-auth 直连 Hono 后端（同源 Cookie 由 CORS + credentials 处理）
      authBaseUrl: 'http://localhost:3001/api/auth',
      // Hono 后端地址，前端直连
      apiBaseUrl: 'http://localhost:3001'
    }
  },

  // 监听 0.0.0.0，方便局域网（手机）访问开发服务器
  devServer: {
    host: '0.0.0.0'
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    // 离线外壳预渲染成静态 HTML：Service Worker 在断网且没有同路径缓存时返回它
    // （见 public/sw.js 与 app/pages/offline.vue）
    prerender: {
      routes: ['/offline']
    },
    routeRules: {
      // PWA 的 manifest 与图标必须是**同源**路径：manifest 里的 start_url / scope 语义
      // 基于它所在的 origin，用跨域地址（http://localhost:3001）会让浏览器拒绝或按
      // 错误的 origin 处理，iOS Safari 更是基本不认。
      //
      // 但开发环境前后端分端口（前端 3000、后端 3001），/api/site-settings/* 会打到
      // Nuxt 上 404 —— 手机上通过局域网访问 dev 时「添加到主屏幕」就读不到 manifest。
      // 故只在这一条前缀上做代理，且**仅限开发环境**（生产由 Caddy 分流，见文件头 isDev）。
      //
      // ⚠️ 必须是精确前缀，不能写成 /api/**:那会连着 /api/_nuxt_icon/* 一起转给 Hono，
      // 于是线上图标整片空白（见下方注释与 deploy/Caddyfile）。
      ...(isDev
        ? { '/api/site-settings/**': { proxy: `${backendBaseUrl}/api/site-settings/**` } }
        : {})
      // 注意：不要在这里添加 /api/** 的全局代理规则，
      // 否则会覆盖 @nuxt/icon 等模块的服务端路由。
      // 生产反代同理：/api/_nuxt_icon/* 必须留在 Nuxt 上，不能跟着 /api/* 转给后端，
      // 否则线上图标整片空白（见 deploy/Caddyfile 与 docs/troubleshooting.md）。
    }
  },

  hooks: {
    // 静态资源都落到 .output/public 之后，生成 SW 的预缓存清单并把构建号写进 sw.js
    'nitro:build:public-assets': async (nitro) => {
      const { version, count } = await generateServiceWorkerManifest(nitro.options.output.publicDir)
      console.log(`[sw] 预缓存清单已生成：${count} 个资源，版本 ${version}`)
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
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
  }
})
