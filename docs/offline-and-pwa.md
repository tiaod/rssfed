# 离线可用（Service Worker）与 PWA

> 本文是「页面壳离线」与「装到主屏幕」两层机制的取舍与踩坑；数据层的离线能力（PouchDB）见
> [ARCHITECTURE.md](../ARCHITECTURE.md) 的「同步架构分层」。

## 离线可用（Service Worker）

「离线优先」在数据上由 PouchDB 保证，但**页面本身也得打得开**——否则断网后连壳都没有。这一层由
`packages/nuxt-client/public/sw.js` 承担，配置见 `nuxt.config.ts`（`nitro.prerender` 与
`nitro:build:public-assets` 钩子），注册见 `app/plugins/service-worker.client.ts`。

三层策略：

| 请求类型 | 策略 | 说明 |
| --- | --- | --- |
| 构建产物 `/_nuxt/**`、静态文件 | 缓存优先 | 文件名带内容哈希，内容永不变化；构建期由钩子扫描 `.output/public` 生成 `/sw-manifest.json`，SW 安装时整份预缓存 |
| 页面导航 | 网络优先 → 同路径 HTML 缓存 → `/offline` 外壳 | 访问过的页面离线可原样打开；没访问过的路径回退到预渲染的离线外壳，客户端接管后按地址栏 URL 渲染真实路由 |
| 只读接口（条目、站点配置、文件、会话） | 网络优先 + 落缓存 | 断网时读缓存；写操作不拦截，让调用方拿到真实失败 |
| 其它（PouchDB 复制 `/api/couchdb/proxy/*` 等） | 不拦截 | 同步语义必须由 PouchDB 自己处理重试与 checkpoint |

几个关键决策：

- **缓存名带构建号**：构建钩子把 `sw.js` 里的 `__BUILD_ID__` 替换成时间戳，新 SW 用新缓存名，
  `activate` 时整体删除旧缓存——避免旧 HTML 去引用已被删除的旧 chunk。
- **不自动 `skipWaiting`**：首次安装直接接管；更新时先待命，由页面提示「有新版本可用」，
  用户点刷新才激活。否则新版一上来就清缓存，正在使用旧版页面的标签页会白屏。
- **开发环境不注册**：缓存优先会挡住 Vite 的 HMR 请求，`app/plugins/service-worker.client.ts`
  里用 `import.meta.dev` 短路。
- **路由中间件在离线时放行**：拿不到会话不该把用户赶去登录页（`app/middleware/auth.ts`）。

## PWA（安装到手机）

站点可以装到手机主屏幕。应用名、图标、主题色全部取自管理员的「站点设置」，改配置不需要改代码或重新构建。

### 为什么 manifest 是动态的、但 URL 是固定的

`<link rel="manifest">` 必须**静态存在于 HTML 中**，并指向一个**同源** URL，内容由服务端按站点配置渲染：

- iOS Safari 只在文档加载时读取 HTML 里静态存在的 manifest，**不支持页面加载后 JS 注入**；
  `blob:` / `data:` URL 也不被浏览器接受。
- 安装时的图标抓取由**浏览器进程独立发起**，不经过页面 JS，所以图标必须是从服务端 URL 直接可取的图片。
- manifest 里 `start_url` / `scope` 的语义基于 manifest 所在的 origin，因此这个 URL 必须同源
  （生产由 Caddy 分流，开发由 `nitro.routeRules` 把 `/api/site-settings/**` 代理到后端）。

端点一览（全部挂在公开的 `/api/site-settings` 前缀下：免登录，且天然落在反代既有的 `/api/*`
规则内，无需为 `/manifest.webmanifest` 单独放行）：

| 端点 | 作用 |
| --- | --- |
| `GET /manifest.webmanifest` | 动态 manifest（`no-cache` + ETag，配置改完立即生效） |
| `GET /icon/192.png`、`/icon/512.png` | 普通图标：透明底、保持宽高比居中 |
| `GET /icon/maskable-512.png` | Android 自适应图标：缩进中心 80% 安全区 + 不透明底 |
| `GET /icon/apple-touch-180.png` | iOS 主屏幕图标（`<link rel="apple-touch-icon">`）：强制不透明 |

### 图标由 sharp 在服务端实时生成

`packages/hono-server/src/pwa/render.ts` 负责渲染，`icons.ts` 负责取源与缓存。取源优先级：
**独立方形图标（附件 → URL）→ 站点 logo（附件 → URL）→ 内置默认图形**。

几处不能省的细节：

- **`sizes` 声明必须与实际像素严格一致**：Chrome 会校验，不符则该图标被静默丢弃，表现为
  「manifest 看着没问题，就是装不上」。故 `ICON_SPECS`（`pwa/manifest.ts`）是 manifest 声明与
  图标输出的**共同真源**，`renderIconPng` 结束前还有一道尺寸自校验。
- **maskable 不能复用普通方图**：Android 会按自己的形状裁切，贴边图形会被切掉。
- **apple-touch 必须不透明**：iOS 会把透明区域填黑，生成时用 `flatten` 去掉 alpha 通道。
- **内置默认图形用纯几何路径而非 `<text>`**：容器镜像里未必装了字体，librsvg 缺字体时文字会整块
  不渲染，而渲染失败是静默的（表现只是主屏图标空白）。前景色按底色亮度自动取黑/白。
- **生成结果按「图标源 + 规格」做进程内 LRU 缓存**：512 图每次约几十毫秒，而图标会被反复抓取。
  server 单副本，不存在多副本不一致。
- 手填外链图标源时限制协议、超时（5s）与体积（5MB）。

### 配置字段与回退链

`site_settings` 表为此新增 6 列（`pnpm db:push`）：`pwa_short_name`、`pwa_display`、
`pwa_theme_color`、`pwa_background_color`、`pwa_icon_url`、`pwa_icon_attachment_id`。全部可空，逐级回退：

| manifest 字段 | 回退链 |
| --- | --- |
| `name` | `site_title` → `RSSFed` |
| `short_name` | `pwa_short_name` → `site_title`（截断至 12 字符） |
| `description` | `description` → 内置默认 |
| `theme_color` | `pwa_theme_color` → `primary_color` → 内置绿 |
| `background_color` | `pwa_background_color` → `primary_color` → 白 |
| `display` | `pwa_display` → `standalone`（非法值一律回退） |

上表是**字段级**回退。另有一层**读取级**兜底：`loadPwaRow()` 查库失败时（连接抖动、迁移还没落地
导致 `pwa_*` 列尚不存在、发布窗口期）按「全空配置」处理，manifest 与图标照样返回内置默认值。
安装 PWA 是纯读路径，降级成默认应用比整个端点 500 更有价值；写入路径不降级，管理员的保存失败仍会
明确报错，避免配置静默丢失。

管理入口：「个人资料 → 站点设置」（管理员）。

### 与 Service Worker 的关系

两者独立：**SW 让已访问过的页面离线可开，manifest 让应用能装到主屏幕**。manifest 与图标路径命中
SW 的 `API_CACHE_PATTERNS`（`/^\/api\/site-settings/`），走网络优先 + 落缓存，断网时也能读到。

> SW 只在安全上下文生效，所以手机上要真正离线可用必须走 HTTPS；通过局域网
> `http://192.168.x.x:3000` 访问开发服务器时，manifest 能读到，但装不上、也离线不了。
