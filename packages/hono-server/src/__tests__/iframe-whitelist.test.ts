import { describe, expect, it } from "vitest"
import {
  DEFAULT_IFRAME_WHITELIST,
  MAX_IFRAME_WHITELIST,
  normalizeIframeWhitelist,
  resolveIframeWhitelist
} from "../iframe-whitelist"
import { ApiError } from "../avatar"

/** 取错误信息，方便断言 422 文案 */
function catchError(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error("预期抛错但没有")
}

describe("DEFAULT_IFRAME_WHITELIST", () => {
  it("每条都是归一化好的 http(s) 前缀", () => {
    expect(DEFAULT_IFRAME_WHITELIST.length).toBeGreaterThan(0)
    for (const entry of DEFAULT_IFRAME_WHITELIST) {
      // 归一化是幂等的：默认值本身必须已经是「整串小写 + URL 规范化」的形态，
      // 否则前端按前缀匹配时（两侧都小写）对不上
      expect(normalizeIframeWhitelist([entry])).toEqual([entry])
    }
  })

  it("覆盖国内外常见视频站", () => {
    const all = DEFAULT_IFRAME_WHITELIST.join("\n")
    expect(all).toContain("youtube.com/embed/")
    expect(all).toContain("player.vimeo.com/video/")
    expect(all).toContain("player.bilibili.com/player.html")
    expect(all).toContain("v.qq.com/txp/iframe/player.html")
    expect(all).toContain("player.youku.com/embed/")
  })
})

describe("normalizeIframeWhitelist", () => {
  it("null 表示恢复内置默认", () => {
    expect(normalizeIframeWhitelist(null)).toBeNull()
  })

  it("空数组是有效配置（不放行任何第三方嵌入）", () => {
    expect(normalizeIframeWhitelist([])).toEqual([])
  })

  it("整串转小写并保留路径前缀", () => {
    expect(normalizeIframeWhitelist(["HTTPS://WWW.YouTube.com/Embed/"])).toEqual([
      "https://www.youtube.com/embed/"
    ])
  })

  it("省略尾斜杠的主机名会被 URL 规范化补上", () => {
    expect(normalizeIframeWhitelist(["https://player.twitch.tv"])).toEqual([
      "https://player.twitch.tv/"
    ])
  })

  it("归一化之后去重且保持顺序", () => {
    expect(normalizeIframeWhitelist([
      "https://a.example/embed/",
      "https://A.example/embed/",
      "https://b.example/embed/"
    ])).toEqual([
      "https://a.example/embed/",
      "https://b.example/embed/"
    ])
  })

  it("非数组、非字符串项、空项一律 422", () => {
    expect(catchError(() => normalizeIframeWhitelist("https://a.example/")).status).toBe(422)
    expect(catchError(() => normalizeIframeWhitelist([123])).status).toBe(422)
    expect(catchError(() => normalizeIframeWhitelist(["  "])).status).toBe(422)
  })

  it("拒绝非 http(s) 与非完整网址", () => {
    expect(catchError(() => normalizeIframeWhitelist(["javascript:alert(1)"])).status).toBe(422)
    expect(catchError(() => normalizeIframeWhitelist(["player.bilibili.com"])).status).toBe(422)
  })

  it("拒绝超长条目与超量数组", () => {
    expect(catchError(() => normalizeIframeWhitelist([
      `https://a.example/${"x".repeat(400)}`
    ])).status).toBe(422)

    const tooMany = Array.from({ length: MAX_IFRAME_WHITELIST + 1 }, (_, i) => `https://h${i}.example/`)
    expect(catchError(() => normalizeIframeWhitelist(tooMany)).status).toBe(422)
  })
})

describe("resolveIframeWhitelist", () => {
  it("未配置时回退内置默认", () => {
    expect(resolveIframeWhitelist(null)).toEqual(DEFAULT_IFRAME_WHITELIST)
    expect(resolveIframeWhitelist(undefined)).toEqual(DEFAULT_IFRAME_WHITELIST)
  })

  it("空数组不会被当成「未配置」", () => {
    expect(resolveIframeWhitelist([])).toEqual([])
  })

  it("返回副本，调用方改不动模块级默认值", () => {
    const resolved = resolveIframeWhitelist(null)
    resolved.push("https://evil.example/")
    expect(DEFAULT_IFRAME_WHITELIST).not.toContain("https://evil.example/")
  })
})
