import { describe, expect, it } from "vitest"
import {
  parseReplicationDocId,
  replicationDocId,
  replicationQueryParams,
} from "../couchdb/replicator"
import { REPLICATION_FILTER_PATH, TIMELINE_REPLICATION_FILTER } from "../couchdb/client"

/**
 * 聚合搬运改成 CouchDB 复制器之后，这层负责的是**拓扑**：复制文档 id 与过滤参数的构造。
 *
 * 两条踩过的坑，用测试钉死：
 *   ① 复制 id 里必须带 windowDays —— checkpoint 由参数哈希决定，删任务不会重置它，
 *      只有换参数（换窗口）才能重扫；
 *   ② 过滤参数名不能叫 `since` —— 会和 `_changes` 自己的 since 撞车，窗口会静默失效。
 *
 * 真库行为（过滤、删除跟随、附件二进制到端、退订取消、换窗口重扫）都在
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

describe("replicationQueryParams", () => {
  it("有下界时给出 minPublishedAt；参数名**不能**叫 since（会和 _changes 的 since 撞车）", () => {
    const params = replicationQueryParams("2025-01-07T00:00:00.000Z")
    expect(params).toEqual({ minPublishedAt: "2025-01-07T00:00:00.000Z" })
    expect(params.since).toBeUndefined()
  })

  it("下界为 null（不限时间 / 该源历史不够保底条数）时不带参数（过滤器放行全部条目）", () => {
    expect(replicationQueryParams(null)).toEqual({})
  })

  it("过滤器挂在源库设计文档上，且删除必须放行（selector 做不到，实测）", () => {
    expect(REPLICATION_FILTER_PATH).toBe("main/timeline")
    expect(TIMELINE_REPLICATION_FILTER).toContain("if (doc._deleted) return true;")
    expect(TIMELINE_REPLICATION_FILTER).toContain("req.query.minPublishedAt")
  })
})

describe("initialWindowBoundIso（已并入 services/timeline.ts 的 windowStartIso）", () => {
  it("窗口下界由 windowStartIso 负责，且「不限时间」表示为 null 而不是一个时间戳", async () => {
    const { windowStartIso } = await import("../services/timeline")
    const now = Date.parse("2025-01-10T00:00:00.000Z")
    expect(windowStartIso(3, now)).toBe("2025-01-07T00:00:00.000Z")
    expect(windowStartIso(30, now)).toBe("2024-12-11T00:00:00.000Z")
    expect(windowStartIso(0, now)).toBeNull()
  })
})
