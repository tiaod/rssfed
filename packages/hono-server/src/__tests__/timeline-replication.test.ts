import { describe, expect, it } from "vitest"
import { parseReplicationDocId, replicationDocId, summarizeReplicationSession } from "../couchdb/replicator"
import { TIMELINE_REPLICATION_SELECTOR } from "../couchdb/client"

/**
 * 聚合搬运改成 CouchDB 复制器之后，这层负责的是**拓扑**：复制文档 id 与 selector 语义。
 *
 * 三条必须钉死的性质（前两条的方向与旧实现相反，改回来就是回归）：
 *   ① selector **必须是常量**：它参与 checkpoint 的哈希，出现随时间变化的谓词会让每个
 *      (用户 × 源) 每天都从 0 重扫源库（早期 `query_params` 窗口就是这么坏掉的）；
 *   ② selector **只匹配活文档**，墓碑进不来 —— 这是刻意的：删除不再传播，保留改由两侧
 *      各自 `_purge` 完成（见 `couchdb/retention.ts`）。旧实现靠"删除放行"让用户库成为镜像，
 *      代价是每个删除在每个用户库都留一个墓碑（实测一个账号 4.2 万个，占 90%）；
 *   ③ 顺手挡住设计文档：`_design/*` 没有 `type` 字段，天然匹配不上（以前是 JS filter 的活）。
 *
 * 真库行为（附件二进制到端、退订取消、两侧保留收敛）在
 * packages/nuxt-client/integration/timeline-sync.test.ts 里对着真 CouchDB 验。
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

describe("聚合复制 selector", () => {
  it("只搬条目与 FeedDoc 元信息（白名单，不是黑名单）", () => {
    expect(TIMELINE_REPLICATION_SELECTOR).toEqual({ type: { $in: ["entry", "feed"] } })
  })

  it("**不含任何时间谓词**：selector 参与 checkpoint 哈希，随时间变 = 每轮全量重扫", () => {
    const serialized = JSON.stringify(TIMELINE_REPLICATION_SELECTOR)
    expect(serialized).not.toContain("publishedAt")
    expect(serialized).not.toContain("$gte")
    expect(serialized).not.toContain("$lt")
    expect(serialized).not.toContain("Date")
  })

  it("**不匹配墓碑**（这是刻意的）：删除后文档没有 type 字段，selector 天然匹配不到", () => {
    // CouchDB 的 selector 只对文档正文字段求值；墓碑只有 _id/_rev/_deleted
    const isMatched = (doc: Record<string, unknown>) => {
      const type = doc.type
      return typeof type === "string" && ["entry", "feed"].includes(type)
    }
    expect(isMatched({ _id: "entry:feed1:abc", _rev: "2-deadbeef", _deleted: true })).toBe(false)
    expect(isMatched({ _id: "_design/main" })).toBe(false)
    expect(isMatched({ _id: "entry:feed1:abc", type: "entry" })).toBe(true)
    expect(isMatched({ _id: "feed:feed1", type: "feed" })).toBe(true)
  })

  it("客户端自写的状态文档不会被搬（源库里本来也没有，但白名单能防将来加类型时误搬）", () => {
    const isMatched = (doc: Record<string, unknown>) => {
      const type = doc.type
      return typeof type === "string" && ["entry", "feed"].includes(type)
    }
    expect(isMatched({ _id: "subscription:f1", type: "subscription" })).toBe(false)
    expect(isMatched({ _id: "entry-state:e1", type: "entry-state" })).toBe(false)
    expect(isMatched({ _id: "group-pref:g1", type: "group-pref" })).toBe(false)
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
