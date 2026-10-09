import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMELINE_SETTINGS,
  chunkByAttachmentBytes,
  entryIdPrefix,
  normalizeAttachments,
  normalizeTimelineSettings,
  parseTimelineSettingsPatch,
  toTimelineEntryDoc,
  windowStartIso,
} from "../services/timeline"

/**
 * 时间线聚合里「纯逻辑」部分的单测：设置归一化与校验、窗口边界、派生文档的构造。
 * 真正的 CouchDB 读写需要真库（见 scripts/verify-timeline-sync.mjs），不在这里假装。
 */

describe("normalizeTimelineSettings", () => {
  it("没有设置行时全部走全局默认", () => {
    expect(normalizeTimelineSettings(null)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(undefined)).toEqual(DEFAULT_TIMELINE_SETTINGS)
  })

  it("只覆盖设置过的字段，其余回退默认（0 是合法值，不能被 ?? 吞掉）", () => {
    const s = normalizeTimelineSettings({ windowDays: 0, aiSummaryEnabled: true })
    expect(s.windowDays).toBe(0)
    expect(s.aiSummaryEnabled).toBe(true)
  })

  it("脏值（负数 / 非数字）回退默认，aiSummaryEnabled 只认 true", () => {
    const s = normalizeTimelineSettings({
      windowDays: -1,
      aiSummaryEnabled: 1 as unknown as boolean,
    })
    expect(s.windowDays).toBe(DEFAULT_TIMELINE_SETTINGS.windowDays)
    expect(s.aiSummaryEnabled).toBe(false)
  })

  it("图片参数不再是用户设置项：设置对象里只有窗口与 AI 开关", () => {
    expect(Object.keys(DEFAULT_TIMELINE_SETTINGS).sort()).toEqual(["aiSummaryEnabled", "windowDays"])
  })
})

describe("parseTimelineSettingsPatch", () => {
  it("合法补丁原样通过", () => {
    const { patch, errors } = parseTimelineSettingsPatch({ windowDays: 30, aiSummaryEnabled: true })
    expect(errors).toEqual([])
    expect(patch).toEqual({ windowDays: 30, aiSummaryEnabled: true })
  })

  it("越界 / 非整数 / 类型错误逐项报错，且不写进补丁", () => {
    const { patch, errors } = parseTimelineSettingsPatch({
      windowDays: 999,
      aiSummaryEnabled: "yes",
    })
    expect(Object.keys(patch)).toHaveLength(0)
    expect(errors).toHaveLength(2)
    expect(errors.join()).toContain("windowDays")
    expect(errors.join()).toContain("aiSummaryEnabled")
  })

  it("图片参数一律不认（它们是 per-feed 的，见 rss/entry-images.ts）", () => {
    // 未知键被忽略：补丁为空 → 路由层按 empty_patch 400，不会静默接受一个「以为生效了」的图片设置
    const { patch, errors } = parseTimelineSettingsPatch({ maxImageCount: 6, avifQuality: 30 })
    expect(errors).toEqual([])
    expect(patch).toEqual({})
  })

  it("非对象入参报错", () => {
    expect(parseTimelineSettingsPatch(null).errors).toEqual(["请求体必须是对象"])
    expect(parseTimelineSettingsPatch("x").errors).toEqual(["请求体必须是对象"])
  })
})

describe("windowStartIso", () => {
  it("按天数回推；0 表示不限时间（null）", () => {
    const now = Date.parse("2025-01-10T00:00:00.000Z")
    expect(windowStartIso(3, now)).toBe("2025-01-07T00:00:00.000Z")
    expect(windowStartIso(0, now)).toBeNull()
    expect(windowStartIso(-1, now)).toBeNull()
  })
})

describe("entryIdPrefix", () => {
  it("feed 与 bot 各自的条目前缀", () => {
    expect(entryIdPrefix("abc123")).toBe("entry:abc123:")
    expect(entryIdPrefix("bot:b1")).toBe("entry:bot:b1:")
  })
})

describe("toTimelineEntryDoc", () => {
  const source = {
    _id: "entry:f1:deadbeef",
    _rev: "1-abc",
    _revisions: { start: 1, ids: ["abc"] },
    _attachments: { "img-0.avif": { content_type: "image/avif", data: "AAAA", revpos: 3, digest: "md5-x" } },
    type: "entry",
    feedId: "f1",
    title: "标题",
    publishedAt: "2025-01-01T00:00:00.000Z",
    images: [{ url: "https://x.test/a.png", attachment: "img-0.avif" }],
  }

  it("丢掉 _rev/_revisions，业务字段与 images 原样保留", () => {
    const doc = toTimelineEntryDoc(source)
    expect(doc._rev).toBeUndefined()
    expect(doc._revisions).toBeUndefined()
    expect(doc._id).toBe("entry:f1:deadbeef")
    expect(doc.type).toBe("entry")
    expect(doc.title).toBe("标题")
    expect(doc.images).toEqual([{ url: "https://x.test/a.png", attachment: "img-0.avif" }])
  })

  it("附件原样搬运：只留 content_type + base64 data（源库的定位元数据不带过去）", () => {
    const doc = toTimelineEntryDoc(source)
    expect(doc._attachments).toEqual({
      "img-0.avif": { content_type: "image/avif", data: "AAAA" },
    })
  })

  it("附件只有 stub（没有 data）时不写 _attachments，条目本身照常入库", () => {
    const doc = toTimelineEntryDoc({
      ...source,
      _attachments: { "img-0.avif": { content_type: "image/avif", stub: true, revpos: 3, digest: "md5-x" } },
    })
    expect(doc._attachments).toBeUndefined()
    expect(doc.title).toBe("标题")
  })
})

describe("normalizeAttachments", () => {
  it("非对象 / 空对象 / 全是 stub 时返回 undefined", () => {
    expect(normalizeAttachments(undefined)).toBeUndefined()
    expect(normalizeAttachments("x")).toBeUndefined()
    expect(normalizeAttachments({})).toBeUndefined()
    expect(normalizeAttachments({ a: { stub: true } })).toBeUndefined()
    expect(normalizeAttachments({ a: { data: "" } })).toBeUndefined()
  })

  it("缺 content_type 时按 octet-stream 兜底（附件仍是可读的字节）", () => {
    expect(normalizeAttachments({ a: { data: "AAA" } })).toEqual({
      a: { content_type: "application/octet-stream", data: "AAA" },
    })
  })
})

describe("chunkByAttachmentBytes", () => {
  const doc = (id: string, bytes = 0) => ({
    _id: id,
    ...(bytes > 0 ? { _attachments: { "img-0.avif": { content_type: "image/avif", data: "x".repeat(bytes) } } } : {}),
  })

  it("常规体积（附件合计远小于预算）就是一批", () => {
    const docs = Array.from({ length: 50 }, (_, i) => doc(`entry:${i}`, 1024))
    expect(chunkByAttachmentBytes(docs)).toHaveLength(1)
  })

  it("附件累计超预算就切批：单个超大附件不会把整页堆进一个请求体", () => {
    const big = 6 * 1024 * 1024
    const batches = chunkByAttachmentBytes([doc("entry:a", big), doc("entry:b", big), doc("entry:c", big)])
    expect(batches.map(b => b.map(d => d._id))).toEqual([["entry:a"], ["entry:b"], ["entry:c"]])
  })

  it("空输入不产生空批", () => {
    expect(chunkByAttachmentBytes([])).toEqual([])
  })
})
