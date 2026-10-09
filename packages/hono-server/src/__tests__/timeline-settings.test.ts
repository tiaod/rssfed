import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMELINE_SETTINGS,
  entryIdPrefix,
  imageParamsChanged,
  normalizeTimelineSettings,
  parseTimelineSettingsPatch,
  sourceCoverUrl,
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

  it("只覆盖设置过的字段，其余回退默认", () => {
    const s = normalizeTimelineSettings({ windowDays: 7, maxImageCount: 0 })
    expect(s.windowDays).toBe(7)
    expect(s.maxImageCount).toBe(0) // 0 是「不缓存图片」的合法值，不能被 ?? 吞掉
    expect(s.maxEntryImageBytes).toBe(DEFAULT_TIMELINE_SETTINGS.maxEntryImageBytes)
    expect(s.aiSummaryEnabled).toBe(false)
  })

  it("脏值（负数 / 非数字）回退默认，aiSummaryEnabled 只认 true", () => {
    const s = normalizeTimelineSettings({
      windowDays: -1,
      maxImageCount: "10" as unknown as number,
      aiSummaryEnabled: 1 as unknown as boolean,
    })
    expect(s.windowDays).toBe(DEFAULT_TIMELINE_SETTINGS.windowDays)
    expect(s.maxImageCount).toBe(DEFAULT_TIMELINE_SETTINGS.maxImageCount)
    expect(s.aiSummaryEnabled).toBe(false)
  })
})

describe("parseTimelineSettingsPatch", () => {
  it("合法补丁原样通过", () => {
    const { patch, errors } = parseTimelineSettingsPatch({ windowDays: 30, maxImageCount: 12, aiSummaryEnabled: true })
    expect(errors).toEqual([])
    expect(patch).toEqual({ windowDays: 30, maxImageCount: 12, aiSummaryEnabled: true })
  })

  it("越界 / 非整数 / 类型错误逐项报错，且不写进补丁", () => {
    const { patch, errors } = parseTimelineSettingsPatch({
      windowDays: 999,
      maxImageCount: 2.5,
      maxImageWidth: "800",
      avifQuality: 0,
      aiSummaryEnabled: "yes",
    })
    expect(Object.keys(patch)).toHaveLength(0)
    expect(errors).toHaveLength(5)
    expect(errors.join()).toContain("windowDays")
    expect(errors.join()).toContain("avifQuality")
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
    _attachments: { "img-0.avif": { content_type: "image/avif", data: "AAAA" } },
    type: "entry",
    feedId: "f1",
    title: "标题",
    publishedAt: "2025-01-01T00:00:00.000Z",
    images: [{ url: "https://x.test/a.png", attachment: "img-0.avif" }],
  }

  it("丢掉源库的 _rev/_attachments，保留业务字段", () => {
    const doc = toTimelineEntryDoc(source, [], [])
    expect(doc._rev).toBeUndefined()
    expect(doc._attachments).toBeUndefined()
    expect(doc._id).toBe("entry:f1:deadbeef")
    expect(doc.type).toBe("entry")
    expect(doc.title).toBe("标题")
    expect("images" in doc).toBe(false) // 没有图片时不该留一个空数组字段
  })

  it("按用户参数生成的图片与附件写进文档（附件为 base64 内联）", () => {
    const doc = toTimelineEntryDoc(
      source,
      [{ url: "https://x.test/b.png", attachment: "img-0.avif", width: 10, height: 20, cover: true }],
      [{ name: "img-0.avif", data: Buffer.from("avif"), content_type: "image/avif" }],
    )
    expect(doc.images).toEqual([{ url: "https://x.test/b.png", attachment: "img-0.avif", width: 10, height: 20, cover: true }])
    expect(doc._attachments).toEqual({
      "img-0.avif": { content_type: "image/avif", data: Buffer.from("avif").toString("base64") },
    })
  })
})

describe("sourceCoverUrl", () => {
  it("取源条目里标记为 cover 的那张", () => {
    expect(sourceCoverUrl({ images: [{ url: "a" }, { url: "b", cover: true }] })).toBe("b")
  })

  it("没有 cover / 没有 images 时返回 undefined", () => {
    expect(sourceCoverUrl({ images: [{ url: "a" }] })).toBeUndefined()
    expect(sourceCoverUrl({})).toBeUndefined()
  })
})

describe("imageParamsChanged", () => {
  it("任何图片参数变化都要求重建", () => {
    const base = { ...DEFAULT_TIMELINE_SETTINGS }
    expect(imageParamsChanged(base, { ...base, maxImageCount: 1 })).toBe(true)
    expect(imageParamsChanged(base, { ...base, avifQuality: 50 })).toBe(true)
    // 窗口与 AI 开关不属于图片参数：它们不需要重建（窗口由 reconcile 回填/剪枝处理）
    expect(imageParamsChanged(base, { ...base, windowDays: 30 })).toBe(false)
    expect(imageParamsChanged(base, { ...base, aiSummaryEnabled: true })).toBe(false)
  })
})
