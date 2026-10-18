import { describe, expect, it } from "vitest"
import {
  botOutputId,
  copyEntryToBotDb,
  type BotCopySourceDb,
  type BotCopyTargetDb,
} from "../workers/bot-sync"

/** 简化版 CouchDB 目标库：用 Map 记文档，multipart 只记录附件名 */
function fakeTargetDb(): BotCopyTargetDb & { docs: Map<string, any>, multipartDocs: Map<string, string[]> } {
  const docs = new Map<string, any>()
  const multipartDocs = new Map<string, string[]>()
  return {
    docs,
    multipartDocs,
    get: async (id: string) => {
      const doc = docs.get(id)
      if (!doc) throw { statusCode: 404, error: "not_found", reason: "missing" }
      return doc
    },
    insert: async (doc: any) => {
      docs.set(doc._id, doc)
      return { ok: true }
    },
    multipart: {
      insert: async (doc: any, attachments: any[]) => {
        docs.set(doc._id, doc)
        multipartDocs.set(doc._id, attachments.map((att) => att.name))
        return { ok: true }
      },
    },
  }
}

function fakeFeedDb(docs: Map<string, any>): BotCopySourceDb {
  return {
    get: async (id: string) => {
      const doc = docs.get(id)
      if (!doc) throw new Error("not_found")
      return doc
    },
  }
}

describe("botOutputId", () => {
  it("把源库 entry id 换成 Bot 产出 id（保留同源 hash）", () => {
    expect(botOutputId("b1", "entry:feed_abc:0123456789ab")).toBe("entry:bot:b1:0123456789ab")
  })

  it("不合法 id 也能确定性地转换（重试幂等的前提）", () => {
    expect(botOutputId("b1", "no-colon-id")).toBe("entry:bot:b1:no-colon-id")
    expect(botOutputId("b1", "no-colon-id")).toBe(botOutputId("b1", "no-colon-id"))
  })
})

describe("copyEntryToBotDb", () => {
  it("目标库已有产出 doc 时跳过，不再读源库", async () => {
    const target = fakeTargetDb()
    target.docs.set("entry:bot:b1:abc", { _id: "entry:bot:b1:abc" })
    let sourceReads = 0
    const source: BotCopySourceDb = {
      get: async () => {
        sourceReads++
        return {}
      },
    }
    expect(await copyEntryToBotDb("b1", "entry:feed:abc", source, target)).toBe(false)
    expect(sourceReads).toBe(0)
  })

  it("无附件的条目：去掉 _rev/_attachments，改写 _id 与 feedId 后插入", async () => {
    const target = fakeTargetDb()
    const source = fakeFeedDb(new Map([
      ["entry:feed:abc", { _id: "entry:feed:abc", _rev: "1-x", title: "t", feedId: "feed_x", _attachments: undefined }],
    ]))
    expect(await copyEntryToBotDb("b1", "entry:feed:abc", source, target)).toBe(true)
    const doc = target.docs.get("entry:bot:b1:abc")
    expect(doc).toMatchObject({ _id: "entry:bot:b1:abc", feedId: "bot:b1", title: "t" })
    expect(doc._rev).toBeUndefined()
  })

  it("有附件的条目：附件 base64 解码后走 multipart 写入（产出 doc 离线可看图）", async () => {
    const target = fakeTargetDb()
    const source = fakeFeedDb(new Map([
      ["entry:feed:abc", {
        _id: "entry:feed:abc",
        _rev: "2-y",
        title: "with image",
        _attachments: {
          "1.avif": { content_type: "image/avif", data: Buffer.from("hello").toString("base64") },
        },
      }],
    ]))
    expect(await copyEntryToBotDb("b1", "entry:feed:abc", source, target)).toBe(true)
    expect(target.multipartDocs.get("entry:bot:b1:abc")).toEqual(["1.avif"])
    expect(target.docs.get("entry:bot:b1:abc")).toMatchObject({ _id: "entry:bot:b1:abc", feedId: "bot:b1" })
  })

  it("源条目不存在时抛出，由队列重试", async () => {
    const target = fakeTargetDb()
    const source = fakeFeedDb(new Map())
    await expect(copyEntryToBotDb("b1", "entry:feed:missing", source, target)).rejects.toThrow("not_found")
  })
})
