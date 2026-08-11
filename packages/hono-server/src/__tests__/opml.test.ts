import { describe, expect, it } from "vitest"
import { parseOpml } from "../rss/opml"

describe("parseOpml", () => {
  it("解析带分组的 OPML：分组名取父级 outline 标题", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feeds</title></head>
  <body>
    <outline text="科技" title="科技">
      <outline type="rss" text="示例博客" title="示例博客" xmlUrl="https://example.com/feed.xml"/>
      <outline type="rss" text="另一博客" xmlUrl="https://another.com/rss"/>
    </outline>
    <outline text="无分组源" xmlUrl="https://no-group.com/feed"/>
  </body>
</opml>`

    const feeds = parseOpml(xml)
    expect(feeds).toEqual([
      { url: "https://example.com/feed.xml", title: "示例博客", category: "科技" },
      { url: "https://another.com/rss", title: "另一博客", category: "科技" },
      { url: "https://no-group.com/feed", title: "无分组源", category: undefined },
    ])
  })

  it("单个顶层 outline 时也能正确解析", () => {
    const xml = `<opml><body>
      <outline type="rss" text="单源" xmlUrl="https://single.com/rss"/>
    </body></opml>`

    const feeds = parseOpml(xml)
    expect(feeds).toHaveLength(1)
    expect(feeds[0]).toEqual({ url: "https://single.com/rss", title: "单源", category: undefined })
  })

  it("多层嵌套时分组取最近一层父级标题", () => {
    const xml = `<opml><body>
      <outline text="外层">
        <outline text="内层">
          <outline type="rss" text="深层源" xmlUrl="https://deep.com/rss"/>
        </outline>
      </outline>
    </body></opml>`

    const feeds = parseOpml(xml)
    expect(feeds).toEqual([{ url: "https://deep.com/rss", title: "深层源", category: "内层" }])
  })

  it("title 缺失时回退到 text，两者都缺时回退到 url", () => {
    const xml = `<opml><body>
      <outline type="rss" xmlUrl="https://only-url.com/rss"/>
    </body></opml>`

    const feeds = parseOpml(xml)
    expect(feeds[0]!.title).toBe("https://only-url.com/rss")
  })

  it("属性值含 XML 实体时能正确解码", () => {
    const xml = `<opml><body>
      <outline type="rss" text="A &amp; B" title="A &amp; B" xmlUrl="https://x.com/feed"/>
    </body></opml>`

    const feeds = parseOpml(xml)
    expect(feeds[0]!.title).toBe("A & B")
  })

  it("非法 XML 抛错", () => {
    expect(() => parseOpml("<<<not xml at all>>>")).toThrow()
  })

  it("缺少 outline 结构时返回空数组", () => {
    const xml = `<opml><body>
      <outline text="空分组"><outline text="还是分组"/></outline>
    </body></opml>`
    expect(parseOpml(xml)).toEqual([])
  })
})
