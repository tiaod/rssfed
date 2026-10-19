import { describe, expect, it } from "vitest"
import { parseReplicationDocId, replicationDocId, summarizeReplicationSession } from "../couchdb/replicator"
import { REPLICATION_FILTER_PATH, TIMELINE_REPLICATION_FILTER } from "../couchdb/client"

/**
 * 聚合搬运改成 CouchDB 复制器之后，这层负责的是**拓扑**：复制文档 id 与过滤器语义。
 *
 * 两条踩过的坑，用测试钉死：
 *   ① 过滤器**必须放行删除**：删除后的文档只有 `_id/_rev/_deleted`，Mango selector 匹配不到
 *      任何字段（实测），只有 JS filter 能拿到它 —— 这是"源库删了、用户库和浏览器跟着删"的唯一机制；
 *   ② 过滤器**不能有时间谓词**：它参与 checkpoint 的哈希，随时间变的谓词会让每个 (用户 × 源)
 *      每天都从 0 重扫源库。保留策略的唯一权威是源库裁剪。
 *
 * 真库行为（删除跟随、附件二进制到端、退订取消、重扫收敛）都在
 * scripts/verify-timeline-sync.mjs 里对着真 CouchDB 验。
 */

describe("replicationDocId / parseReplicationDocId", () => {
  it("id 里带 userId、windowDays 与 sourceId，且能原样解析回来", () => {
    const id = replicationDocId("u1", 3, "feed123")
    expect(id).toBe("rssfed-u1:w3:feed123")
    expect(parseReplicationDocId(id)).toEqual({ userId: "u1", windowDays: 3, sourceId: "feed123" })
  })

  it("bot 源 id 里本身带冒号，解析不能把它截断", () => {
    const id = replicationDocId("u1", 0, "bot:b9")
    expect(parseReplicationDocId(id)).toEqual({ userId: "u1", windowDays: 0, sourceId: "bot:b9" })
  })

  it("换窗口就是另一条复制任务（另一个复制哈希 → 从 0 重扫回填）", () => {
    expect(replicationDocId("u1", 3, "f1")).not.toBe(replicationDocId("u1", 7, "f1"))
  })

  it("不是本服务创建的复制文档返回 null（别人的任务/脏数据都不能被误删）", () => {
    expect(parseReplicationDocId("some-other-replication")).toBeNull()
    expect(parseReplicationDocId("rssfed-u1:feed123")).toBeNull()
    expect(parseReplicationDocId("rssfed-u1:w3")).toBeNull()
    expect(parseReplicationDocId("rssfed-u1:w-1:f1")).toBeNull()
  })

  it("同一用户不同源的 id 互不覆盖，前缀列举只圈住这个用户", () => {
    const mine = [replicationDocId("u1", 3, "f1"), replicationDocId("u1", 3, "f2")]
    const other = replicationDocId("u2", 3, "f1")
    for (const id of mine) expect(id.startsWith("rssfed-u1:")).toBe(true)
    expect(other.startsWith("rssfed-u1:")).toBe(false)
    // 前缀 + \uffff 的范围查询不会把别的用户带进来
    expect(other > "rssfed-u1:\uffff").toBe(true)
  })
})

describe("聚合复制过滤器", () => {
  /** 把设计文档里的 filter 源码当函数求值，直接验语义（比字符串断言靠谱） */
  const filter = new Function(`return (${TIMELINE_REPLICATION_FILTER})`)() as (doc: Record<string, unknown>) => boolean

  it("挂在源库设计文档上", () => {
    expect(REPLICATION_FILTER_PATH).toBe("main/timeline")
  })

  it("**放行删除**（Mango selector 做不到）—— 源库裁剪才能传到用户库", () => {
    expect(filter({ _id: "entry:feed1:abc", _rev: "2-deadbeef", _deleted: true })).toBe(true)
  })

  it("放行条目与 FeedDoc 元信息", () => {
    expect(filter({ _id: "entry:feed1:abc", type: "entry", publishedAt: "2026-01-01T00:00:00.000Z" })).toBe(true)
    expect(filter({ _id: "feed:feed1", type: "feed" })).toBe(true)
  })

  it("**挡住设计文档**：用户库自己也有 _design/main，搬过去会撞车", () => {
    expect(filter({ _id: "_design/main" })).toBe(false)
  })

  it("没有时间谓词（否则随时间变的过滤器源码 = 换哈希 = 每轮全量重扫）", () => {
    expect(TIMELINE_REPLICATION_FILTER).not.toContain("publishedAt")
    expect(TIMELINE_REPLICATION_FILTER).not.toContain("req.query")
  })
})

describe("summarizeReplicationSession", () => {
  it("无变化（本次 session 不在 history 里）→ 写了 0，不拿上一次会话的旧数据冒充", () => {
    expect(summarizeReplicationSession({
      session_id: "new-noop-session",
      history: [{ session_id: "old", docs_written: 4782, doc_write_failures: 0 }],
    })).toEqual({ docsWritten: 0, writeFailures: 0 })
  })

  it("history 计数是累计值，要减去上一条才是本次增量", () => {
    expect(summarizeReplicationSession({
      session_id: "s3",
      history: [
        { session_id: "s3", docs_written: 7, doc_write_failures: 0 },
        { session_id: "s2", docs_written: 6, doc_write_failures: 0 },
        { session_id: "s1", docs_written: 4, doc_write_failures: 0 },
      ],
    })).toEqual({ docsWritten: 1, writeFailures: 0 })
  })

  it("第一次会话没有上一条可比，整份都算本次", () => {
    expect(summarizeReplicationSession({
      session_id: "s1",
      history: [{ session_id: "s1", docs_written: 4219, doc_write_failures: 0 }],
    })).toEqual({ docsWritten: 4219, writeFailures: 0 })
  })

  it("写失败同样是增量：历史失败不会让水位永远卡住", () => {
    expect(summarizeReplicationSession({
      session_id: "s2",
      history: [
        { session_id: "s2", docs_written: 10, doc_write_failures: 2 },
        { session_id: "s1", docs_written: 8, doc_write_failures: 2 },
      ],
    })).toEqual({ docsWritten: 2, writeFailures: 0 })
    expect(summarizeReplicationSession({
      session_id: "s3",
      history: [
        { session_id: "s3", docs_written: 11, doc_write_failures: 3 },
        { session_id: "s2", docs_written: 10, doc_write_failures: 2 },
      ],
    })).toEqual({ docsWritten: 1, writeFailures: 1 })
  })
})
