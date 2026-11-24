import { describe, expect, it } from "vitest"
import { USER_TIMELINE_TRIM_VIEW } from "../couchdb/retention"
import { OWNER_DESIGN_DOC_VIEWS, TIMELINE_VALIDATE_DOC_UPDATE } from "../couchdb/client"

/**
 * 裁剪用的视图路径必须真的是设计文档里装的那个。
 *
 * 这是实机验证抓出来的真 bug：`USER_TIMELINE_TRIM_VIEW` 还写着旧的
 * `timeline-maintain/by-feed-date`（旧模型里用户库的设计文档 id），而新的设计文档是
 * `_design/main` —— 于是抓取完成后每次裁剪都 404（视图不存在），
 * 表现是「库只增不减、过期条目永不清理」，而且日志里只有一行告警。
 *
 * 这类不一致**编译器看不出来**（两边都是字符串字面量），所以用一条测试钉住：
 * 常量拆出来的 `design/view` 必须在 `OWNER_DESIGN_DOC_VIEWS` 里存在。
 */
describe("裁剪视图路径与设计文档一致", () => {
  it("USER_TIMELINE_TRIM_VIEW 的 design 是 main、view 真的装在设计文档里", () => {
    const [design, view] = USER_TIMELINE_TRIM_VIEW.split("/")
    expect(design).toBe("main")
    expect(view).toBe("by-feed-date")
    expect(OWNER_DESIGN_DOC_VIEWS).toHaveProperty(view!)
  })

  it("设计文档里有裁剪需要的两个视图", () => {
    expect(Object.keys(OWNER_DESIGN_DOC_VIEWS).sort()).toEqual(["by-feed-date", "entries-by-date"])
  })

  it("by-feed-date 的 key 是 [feedId, publishedAt]（逐源裁剪依赖这个行序）", () => {
    const map = OWNER_DESIGN_DOC_VIEWS["by-feed-date"]!.map
    expect(map).toContain("doc.feedId")
    expect(map).toContain("doc.publishedAt")
    expect(map).toContain("emit([doc.feedId, doc.publishedAt]")
  })

  it("写方向闸门禁掉 entry / feed（客户端可写这个库，但抓取产物归服务端）", () => {
    expect(TIMELINE_VALIDATE_DOC_UPDATE).toContain("entry")
    expect(TIMELINE_VALIDATE_DOC_UPDATE).toContain("feed")
    expect(TIMELINE_VALIDATE_DOC_UPDATE).toContain("forbidden")
    // `_admin` 必须放行：服务端经代理写库时是 user 身份，直接连时是 admin
    expect(TIMELINE_VALIDATE_DOC_UPDATE).toContain("_admin")
  })
})
