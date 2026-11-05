import { SITE_SETTINGS_SNAPSHOT_KEY } from '~/utils/siteSettingsSnapshot'

/**
 * 站点主题色（管理员在「站点设置」里配置的 hex）到 Nuxt UI 主色变量的映射。
 *
 * Nuxt UI v4 在运行时由 colors 插件生成 `--ui-color-primary-*` 色阶，并据此派生
 * `--ui-primary`（浅色模式取 500、深色模式取 400），组件再用 `--ui-primary` 上色。
 * 因此只要覆写这 11 个色阶，站长配置的主题色即可在明暗两种模式下同时生效。
 *
 * 站点公开配置只在前端拉取，故这里只做「颜色 → CSS」与「CSS → DOM」的纯逻辑，便于单测。
 */

/** #rgb / #rrggbb，大小写不敏感（与后端 site-settings 的校验保持一致） */
export const PRIMARY_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Nuxt UI 使用的 11 个色阶 */
export const PRIMARY_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

type Shade = (typeof PRIMARY_SHADES)[number]

/**
 * 各色阶相对基色的混合比例：比 500 浅的与白色混合，比 500 深的与黑色混合。
 * 500 直接使用基色（ratio 100），保证站长选什么颜色，主按钮就是什么颜色。
 */
const SHADE_MIX: Record<Shade, { ref: 'white' | 'black', ratio: number }> = {
  50: { ref: 'white', ratio: 7 },
  100: { ref: 'white', ratio: 14 },
  200: { ref: 'white', ratio: 28 },
  300: { ref: 'white', ratio: 45 },
  400: { ref: 'white', ratio: 70 },
  500: { ref: 'white', ratio: 100 },
  600: { ref: 'black', ratio: 88 },
  700: { ref: 'black', ratio: 76 },
  800: { ref: 'black', ratio: 64 },
  900: { ref: 'black', ratio: 52 },
  950: { ref: 'black', ratio: 40 }
}

/** 把 #rgb 归一化为 #rrggbb 小写；非法或空输入返回 null */
export function normalizeHexColor(input: string | null | undefined): string | null {
  // 站点配置字段全部可空（未设置即回退默认），调用方直接透传即可，不必各自判空
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!PRIMARY_COLOR_RE.test(value)) return null
  if (value.length === 7) return value.toLowerCase()
  // #rgb → #rrggbb
  const [r, g, b] = value.slice(1).toLowerCase()
  return `#${r}${r}${g}${g}${b}${b}`
}

/**
 * 生成覆写 Nuxt UI 主色色阶的 CSS；颜色非法时返回 null（调用方据此移除覆写、回退默认主题）。
 *
 * 选择器同时覆盖 :root/:host/.light/.dark：Nuxt UI 的 colors 插件在 `:root, :host` 下
 * 声明色阶，本站点主题样式注入在其后，同优先级下后者生效。
 */
export function buildPrimaryColorCss(input: string): string | null {
  const base = normalizeHexColor(input)
  if (!base) return null

  const declarations = PRIMARY_SHADES.map((shade) => {
    const { ref, ratio } = SHADE_MIX[shade]
    const value = ratio >= 100 ? base : `color-mix(in oklab, ${base} ${ratio}%, ${ref})`
    return `  --ui-color-primary-${shade}: ${value};`
  }).join('\n')

  return `:root, :host, .light, .dark {\n${declarations}\n}`
}

/** 承载站点主题色的 <style> 元素 id；元素不存在即表示回退 Nuxt UI 默认主题 */
export const SITE_PRIMARY_STYLE_ID = 'site-primary-color'

/**
 * 把主题色应用到文档：写入覆写色阶的 <style>；颜色为空或非法时移除该样式回退默认主题。
 *
 * 样式追加到 <head> 末尾，晚于 Nuxt UI colors 插件生成的色阶声明，同优先级下后者生效。
 * 传入 doc 便于单测（happy-dom）。
 */
export function applyPrimaryColor(doc: Document, primaryColor?: string | null): void {
  // undefined = 配置尚未拉取完成：保留现有覆写。插件在 hydration 前会以
  // immediate watch 调用一次，此时若按「未配置」移除样式，就会把首屏内联脚本
  // 按本地快照写入的主题色清掉，重新闪一次默认绿。
  if (primaryColor === undefined) return
  const css = primaryColor ? buildPrimaryColorCss(primaryColor) : null
  const existing = doc.getElementById(SITE_PRIMARY_STYLE_ID)

  if (!css) {
    existing?.remove()
    return
  }

  let style = existing as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = SITE_PRIMARY_STYLE_ID
    doc.head.appendChild(style)
  }
  style.textContent = css
}

/**
 * 首屏主题色引导脚本（由 app.vue 注入到 <head>，随 SSR 输出）。
 *
 * 站点配置平时是客户端拉取后异步应用的，SSR 首帧只有内置绿；断网时若 SW 缓存也被
 * 换掉，连拉取都拿不到。把 localStorage 快照里的 `primaryColor` 在 HTML 解析阶段
 * 同步写成 `<style>`，首帧就是站长配置的颜色，既消掉闪烁，也扛住「升级后首次离线」。
 *
 * 色阶表与混合比例必须与上面的 `SHADE_MIX` / `PRIMARY_SHADES` 一致 —— 脚本不能
 * import 模块，只能内联一份，故用单测比对它生成的 CSS 与 `buildPrimaryColorCss`
 * 完全相同来防止漂移。
 */
export const SITE_THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var raw=window.localStorage.getItem(${JSON.stringify(SITE_SETTINGS_SNAPSHOT_KEY)});
if(!raw)return;
var c=(JSON.parse(raw)||{}).primaryColor;
if(typeof c!=='string')return;
c=c.trim();
if(!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c))return;
if(c.length===4){var r=c[1],g=c[2],b=c[3];c='#'+r+r+g+g+b+b}
c=c.toLowerCase();
var m={50:['white',7],100:['white',14],200:['white',28],300:['white',45],400:['white',70],500:['white',100],600:['black',88],700:['black',76],800:['black',64],900:['black',52],950:['black',40]};
var d='';
for(var s in m){var x=m[s];d+='  --ui-color-primary-'+s+': '+(x[1]>=100?c:'color-mix(in oklab, '+c+' '+x[1]+'%, '+x[0]+')')+';\\n'}
var el=document.getElementById(${JSON.stringify(SITE_PRIMARY_STYLE_ID)});
if(!el){el=document.createElement('style');el.id=${JSON.stringify(SITE_PRIMARY_STYLE_ID)};document.head.appendChild(el)}
el.textContent=':root, :host, .light, .dark {\\n'+d+'}';
}catch(e){}})();`
