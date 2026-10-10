import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMELINE_SETTINGS,
  entryIdPrefix,
  normalizeTimelineSettings,
  parseTimelineSettingsPatch,
  windowStartIso,
} from "../services/timeline"

/**
 * 时间线聚合里「纯逻辑」部分的单测：设置归一化与校验、窗口边界、源条目前缀。
 * 真正的 CouchDB 读写（复制拓扑、剪枝、迁移）需要真库，见
 * scripts/verify-timeline-sync.mjs 与 __tests__/timeline-replication.test.ts。
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
