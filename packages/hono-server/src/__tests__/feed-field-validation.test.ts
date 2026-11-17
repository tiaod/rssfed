import { afterAll, describe, expect, it } from "vitest"

/**
 * 订阅源字段的 URL 校验（管理端 PUT）。
 *
 * 关键取舍（见 services/feed-field-validation.ts 文件头）：
 *  - `url` / `image` **服务端真的会去请求** → 必须拦内网（SSRF）；
 *  - `siteUrl` 只是前端跳转链接 → 只查协议，**不查内网**；
 *  - 空串合法（表示清空字段），库里本来就有这种值。
 *
 * 现有数据里 `arQo7BMXRjpAFtXb` / `KEwHKZQWBgrM5IGP` 的 siteUrl 就是 `http://localhost:8099/`，
 * 若把 siteUrl 也按内网拦，这些源改任何字段（包括只改标题）都会被卡住 —— 这是本文件要钉住的。
 *
 * ⚠️ 全局 vitest 配置开着 `SSRF_GUARD_ALLOW_PRIVATE=1`（其它测试要靠 127.0.0.1 的临时服务），
 * 会让内网判定整体放行。这里在导入被测模块前清掉，否则"拦内网"的用例会假绿/假红。
 */

const savedFlag = process.env.SSRF_GUARD_ALLOW_PRIVATE
delete process.env.SSRF_GUARD_ALLOW_PRIVATE

const { validateFeedPatch, validateFeedUrlField } = await import("../services/feed-field-validation")

afterAll(() => {
  if (savedFlag === undefined) delete process.env.SSRF_GUARD_ALLOW_PRIVATE
  else process.env.SSRF_GUARD_ALLOW_PRIVATE = savedFlag
})

describe("validateFeedUrlField", () => {
  it("合法公网地址放行", async () => {
    expect(await validateFeedUrlField("url", "https://example.com/feed.xml", true)).toBeNull()
    expect(await validateFeedUrlField("siteUrl", "https://example.com", false)).toBeNull()
  })

  it("空串放行（语义是清空字段）", async () => {
    expect(await validateFeedUrlField("image", "", true)).toBeNull()
    expect(await validateFeedUrlField("siteUrl", "   ", false)).toBeNull()
  })

  it("非 URL 字符串被拒", async () => {
    const err = await validateFeedUrlField("url", "abc", true)
    expect(err).toMatchObject({ field: "url" })
    expect(err?.message).toMatch(/不是合法的网址/)
  })

  it("非 http(s) 协议被拒（防 javascript: 之类的跳转协议）", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x/y"]) {
      const err = await validateFeedUrlField("siteUrl", bad, false)
      expect(err?.message).toMatch(/只支持 http\/https/)
    }
  })

  it("url / image 指向内网时被拒（服务端会去请求）", async () => {
    for (const bad of [
      "http://127.0.0.1:5984/",
      "http://localhost:1200/feed",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/rss",
      "http://[::1]:8080/",
    ]) {
      const err = await validateFeedUrlField("url", bad, true)
      expect(err, bad).not.toBeNull()
      expect(err?.message).toMatch(/内网|保留地址/)
    }
    expect(await validateFeedUrlField("image", "http://127.0.0.1:9000/icon.png", true)).not.toBeNull()
  })

  it("siteUrl 指向内网**不**拦（它不会被服务端访问，前端跳转而已）", async () => {
    // 现有数据里就有这种值，拦了会让这些源改任何字段都被卡住
    expect(await validateFeedUrlField("siteUrl", "http://localhost:8099/", false)).toBeNull()
    expect(await validateFeedUrlField("siteUrl", "http://127.0.0.1:8080/", false)).toBeNull()
  })
})

describe("validateFeedPatch", () => {
  it("全部合法时返回 null", async () => {
    expect(await validateFeedPatch({
      title: "标题",
      url: "https://example.com/rss",
      siteUrl: "https://example.com",
      image: "https://example.com/icon.png",
    })).toBeNull()
  })

  it("只改标题时不校验 URL 字段（那些字段根本不传）", async () => {
    expect(await validateFeedPatch({ title: "只改标题" })).toBeNull()
  })

  it("非字符串值跳过（交由上游的类型判断处理）", async () => {
    expect(await validateFeedPatch({ url: null, image: 123 })).toBeNull()
  })

  it("命中哪个字段就报哪个字段", async () => {
    expect(await validateFeedPatch({ url: "abc" })).toMatchObject({ field: "url" })
    expect(await validateFeedPatch({ image: "not a url" })).toMatchObject({ field: "image" })
    expect(await validateFeedPatch({ siteUrl: "javascript:1" })).toMatchObject({ field: "siteUrl" })
  })

  it("url 与 image 走内网检查，siteUrl 不走", async () => {
    expect(await validateFeedPatch({ url: "http://127.0.0.1/x" })).toMatchObject({ field: "url" })
    expect(await validateFeedPatch({ image: "http://127.0.0.1/x" })).toMatchObject({ field: "image" })
    expect(await validateFeedPatch({ siteUrl: "http://127.0.0.1/x" })).toBeNull()
  })
})
