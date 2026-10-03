/**
 * Playwright 运行环境自举（`scripts/verify-*.mjs` 共用）。
 *
 * 本机是容器：系统没有 Chromium，且缺 libnspr4 / libnss3 / libasound2，而 NoNewPrivs=1 +
 * 非 root 意味着装不了系统包。浏览器正常走 playwright 的默认缓存
 * （`pnpm exec playwright install chromium`），缺的这几个库与中文字体则解包到项目里，
 * 这里自动挂上，调用方直接 `node` 跑就行，不必每次拼一长串环境变量。
 *
 * 用法 —— **必须在 import('playwright') 之前调用**：playwright 在加载时就会确定浏览器查找目录。
 *
 * ```js
 * import { preparePlaywrightEnv } from './lib/playwright-env.mjs'
 * await preparePlaywrightEnv()
 * const { chromium } = await import('playwright')
 * ```
 *
 * 想覆盖时仍可用 PLAYWRIGHT_BROWSERS_PATH / LD_LIBRARY_PATH / FONTCONFIG_FILE。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根（脚本产物固定落在它的 report/ 下，不管从哪个目录调用） */
export const REPO_ROOT = path.resolve(HERE, '../../../..')

/** 备用：项目内也放一份浏览器时用它（正常情况下用默认缓存即可） */
const LOCAL_BROWSERS = path.join(REPO_ROOT, 'node_modules/.playwright-browsers')
/** 缺的系统库：apt-get download + dpkg -x 解包到这里，靠 LD_LIBRARY_PATH 生效 */
const LOCAL_LIBS = path.join(REPO_ROOT, 'node_modules/.pw-syslibs/usr/lib/x86_64-linux-gnu')
/** 缺的中文字体：同样解包到这里，靠 FONTCONFIG_FILE 让 Chromium 找到 */
const LOCAL_FONTS = path.join(REPO_ROOT, 'node_modules/.pw-fonts')
const LOCAL_FONTS_DIR = path.join(LOCAL_FONTS, 'usr/share/fonts')

/**
 * 生成 fontconfig 配置（幂等）。
 *
 * 系统里一个中文字体都没有，不挂这个的话截图里中文全是方框。
 * 用 include 保住系统原有配置，再把自己的字体目录加进去，并显式让 zh 优先
 * 落到 Noto Sans CJK SC —— 只有 <dir> 不够：sans-serif 的 alias 在系统配置里
 * 指向的都是没装的字体，fc-match 会退到 DejaVu（它没有中文字形）。
 * cachedir 必须给可写位置，容器里 HOME 下的缓存目录写不了。
 */
function ensureFontsConf() {
  if (!fs.existsSync(LOCAL_FONTS_DIR)) return null
  const confPath = path.join(LOCAL_FONTS, 'fonts.conf')
  const cacheDir = path.join(LOCAL_FONTS, 'cache')
  const content = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${LOCAL_FONTS_DIR}</dir>
  <cachedir>${cacheDir}</cachedir>
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>Noto Sans CJK SC</string></edit>
  </match>
</fontconfig>
`
  try {
    if (fs.readFileSync(confPath, 'utf8') !== content) {
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(confPath, content)
    }
  } catch {
    return null
  }
  return confPath
}

/** 本地备用目录里真有 chromium 才算数（目录可能只残留别的东西） */
function hasLocalChromium() {
  try {
    return fs.readdirSync(LOCAL_BROWSERS).some(name => name.startsWith('chromium'))
  } catch {
    return false
  }
}

/** playwright 自带浏览器在各平台的默认缓存目录 */
function defaultBrowserCache() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ms-playwright')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Caches/ms-playwright')
  }
  return path.join(os.homedir(), '.cache/ms-playwright')
}

/** 接好环境变量；幂等，重复调用无副作用 */
export function preparePlaywrightEnv() {
  // 浏览器目录优先级：显式指定 > 默认缓存（playwright install 装的）> 项目内备用
  if (
    !process.env.PLAYWRIGHT_BROWSERS_PATH
    && !fs.existsSync(defaultBrowserCache())
    && hasLocalChromium()
  ) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS
  }
  // 缺的系统库只在 sysroot 存在时追加，不覆盖你已有的 LD_LIBRARY_PATH
  if (fs.existsSync(LOCAL_LIBS)) {
    process.env.LD_LIBRARY_PATH = [LOCAL_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }
  // 中文字体：没有它截图里全是方框
  // 注意不要顺手改 XDG_CACHE_HOME —— playwright 会用它推导浏览器缓存目录，
  // 一改就跑去找 $XDG_CACHE_HOME/ms-playwright，直接报「浏览器没装」。
  // fontconfig 的缓存目录在 fonts.conf 里单独指定了。
  const fontsConf = ensureFontsConf()
  if (fontsConf && !process.env.FONTCONFIG_FILE) {
    process.env.FONTCONFIG_FILE = fontsConf
  }
}
