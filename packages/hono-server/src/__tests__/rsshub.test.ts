import { describe, expect, it, vi } from "vitest"

describe("rewriteRssHubUrl", () => {
  /** 以指定 RSSHUB_BASE_URL 重新加载模块（模块级常量在顶层求值，需重置模块注册表） */
  async function load(base: string | undefined) {
    vi.resetModules()
    if (base === undefined) delete process.env.RSSHUB_BASE_URL
    else process.env.RSSHUB_BASE_URL = base
    const mod = await import("../rss/rsshub")
    return mod.rewriteRssHubUrl as (url: string) => string
  }

  it("未配置 RSSHUB_BASE_URL 时原样返回", async () => {
    const rewrite = await load(undefined)
    expect(rewrite("https://rsshub.app/smzdm/haowen/1")).toBe("https://rsshub.app/smzdm/haowen/1")
  })

  it("配置后把 rsshub.app 改写为本地地址，保留路径与查询", async () => {
    const rewrite = await load("http://localhost:1200")
    expect(rewrite("https://rsshub.app/smzdm/haowen/1"))
      .toBe("http://localhost:1200/smzdm/haowen/1")
    expect(rewrite("https://rsshub.app/bilibili/user/video/18028611?k=v"))
      .toBe("http://localhost:1200/bilibili/user/video/18028611?k=v")
  })

  it("本地基础地址自带子路径时正确拼接", async () => {
    const rewrite = await load("http://rsshub.example.com/rss")
    expect(rewrite("https://rsshub.app/smzdm/haowen/1"))
      .toBe("http://rsshub.example.com/rss/smzdm/haowen/1")
  })

  it("非 rsshub.app 主机不受影响", async () => {
    const rewrite = await load("http://localhost:1200")
    expect(rewrite("https://example.com/feed.xml")).toBe("https://example.com/feed.xml")
    expect(rewrite("https://rsshub.app.evil.com/feed")).toBe("https://rsshub.app.evil.com/feed")
  })

  it("非法 URL 原样返回", async () => {
    const rewrite = await load("http://localhost:1200")
    expect(rewrite("not-a-url")).toBe("not-a-url")
  })

  it("基础地址末尾多余斜杠被归一化", async () => {
    const rewrite = await load("http://localhost:1200/")
    expect(rewrite("https://rsshub.app/foo")).toBe("http://localhost:1200/foo")
  })
})
