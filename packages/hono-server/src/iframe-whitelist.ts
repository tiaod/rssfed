import { ApiError } from "./avatar"

/**
 * 正文 <iframe> 的第三方白名单。
 *
 * 与订阅源**同源**的嵌入不需要登记（见前端 `app/utils/iframePolicy.ts`），这里维护的是
 * 视频/音频站的播放器地址前缀 —— 白名单落在服务端配置里，管理员改完当次请求即生效。
 *
 * 登记的是**网址前缀**而不是主机名：这些站的播放器只在特定路径下（`/embed/`、
 * `/player.html`、`/txp/iframe/player.html` …）才是播放器页面，只按主机放行等于把整站
 * 都变成可嵌入画布（钓鱼页面照抄登录框就能塞进阅读器正文）。前缀能把授权收在播放器上。
 *
 * 匹配时两侧都会转小写（见前端 `resolveIframeSrc`），所以这里统一以小写登记。
 */
export const DEFAULT_IFRAME_WHITELIST: string[] = [
  // ── 国外 ────────────────────────────────────────────────────────────────
  "https://www.youtube.com/embed/",
  "https://www.youtube-nocookie.com/embed/",
  "https://player.vimeo.com/video/",
  "https://www.dailymotion.com/embed/video/",
  "https://player.twitch.tv/",
  "https://www.twitch.tv/embed/",
  "https://open.spotify.com/embed/",
  "https://w.soundcloud.com/player/",
  "https://streamable.com/e/",
  "https://rumble.com/embed/",
  "https://odysee.com/$/embed/",
  "https://bandcamp.com/embeddedplayer/",
  "https://www.facebook.com/plugins/video.php",
  "https://vk.com/video_ext.php",
  "https://embed.nicovideo.jp/watch/",
  // ── 国内 ────────────────────────────────────────────────────────────────
  "https://player.bilibili.com/player.html",
  "https://v.qq.com/txp/iframe/player.html",
  "https://player.youku.com/embed/",
  "https://open.iqiyi.com/developer/player_js/",
  "https://www.ixigua.com/iframe/",
  "https://open.douyin.com/player/video",
  "https://www.acfun.cn/player/",
  "https://music.163.com/outchain/player",
  "https://i.y.qq.com/n2/m/outchain/player"
]

/** 单个条目的长度上限：地址前缀不该有这么长，超了基本是粘贴错东西 */
const MAX_ENTRY_LENGTH = 300

/**
 * 条目数量上限。
 * 白名单是给人维护的列表，到这个量级说明该改用「与订阅源同源」或换配置方式了；
 * 同时它也是防御性的：避免管理员接口被灌入一个巨大的 jsonb。
 */
export const MAX_IFRAME_WHITELIST = 200

/**
 * 读取生效的白名单：库里没配（null）时回退内置默认。
 * 空数组是**有效配置**（= 不放行任何第三方 iframe），不能和 null 混为一谈。
 */
export function resolveIframeWhitelist(stored: string[] | null | undefined): string[] {
  return stored ? [...stored] : [...DEFAULT_IFRAME_WHITELIST]
}

/**
 * 校验并归一化管理员提交的白名单（归一化规则与前端匹配方式一致：整串小写）。
 *
 * - `null` 表示「恢复内置默认」（删掉自定义配置）
 * - 必须是数组；每一项都得是完整的 http/https 网址
 * - 去重（归一化之后），保持提交顺序
 *
 * 非法输入抛 ApiError(422)。`undefined` 不属于本函数的职责：路由层把「字段未出现」
 * 理解为「不修改」，根本不会调用到这里。
 */
export function normalizeIframeWhitelist(input: unknown): string[] | null {
  if (input === null) return null
  if (!Array.isArray(input)) throw new ApiError(422, "iframe 白名单需为数组，或传 null 恢复默认")
  if (input.length > MAX_IFRAME_WHITELIST) {
    throw new ApiError(422, `iframe 白名单最多 ${MAX_IFRAME_WHITELIST} 项`)
  }

  const normalized: string[] = []
  for (const item of input) {
    if (typeof item !== "string") throw new ApiError(422, "iframe 白名单每一项都需为字符串")
    const raw = item.trim()
    if (!raw) throw new ApiError(422, "iframe 白名单不能包含空项")
    if (raw.length > MAX_ENTRY_LENGTH) {
      throw new ApiError(422, `单个 iframe 地址不能超过 ${MAX_ENTRY_LENGTH} 个字符`)
    }

    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new ApiError(422, `iframe 地址需为完整网址（含 https://）：${raw}`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ApiError(422, `iframe 地址只支持 http/https：${raw}`)
    }

    // URL 规范化会补上被省略的尾斜杠（https://host → https://host/），
    // 因此「只写主机名」的条目等价于放行该主机下的所有页面
    const value = url.href.toLowerCase()
    if (!normalized.includes(value)) normalized.push(value)
  }
  return normalized
}
