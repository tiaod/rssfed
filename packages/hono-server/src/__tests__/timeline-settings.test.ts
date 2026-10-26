import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMELINE_SETTINGS,
  entryIdPrefix,
  normalizeTimelineSettings,
  parseTimelineSettingsPatch,
} from "../services/timeline"

/**
 * 时间线聚合里「纯逻辑」部分的单测：设置归一化与校验、源条目前缀。
 *
 * 保留策略**不再是用户设置**：它是源库裁剪（每源最新 50 条），全局一个值、跟着复制传播到
 * 用户库，所以设置对象里只剩 AI 摘要开关。真正的 CouchDB 读写（复制拓扑、重建、退订清理）
 * 需要真库，见 timeline-replication.test.ts / timeline-rebuild.test.ts 与
 * packages/nuxt-client/integration/timeline-sync.test.ts。
 */

describe("normalizeTimelineSettings", () => {
  it("没有设置行时走默认（aiSummaryEnabled = false）", () => {
    expect(normalizeTimelineSettings(null)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(normalizeTimelineSettings(undefined)).toEqual(DEFAULT_TIMELINE_SETTINGS)
    expect(DEFAULT_TIMELINE_SETTINGS).toEqual({ aiSummaryEnabled: false })
  })

  it("true 原样透传", () => {
    expect(normalizeTimelineSettings({ aiSummaryEnabled: true })).toEqual({ aiSummaryEnabled: true })
  })

  it("只有明确的 true 才算开启（false / 脏值一律回退 false）", () => {
    expect(normalizeTimelineSettings({ aiSummaryEnabled: false })).toEqual({ aiSummaryEnabled: false })
    expect(normalizeTimelineSettings({ aiSummaryEnabled: 1 as unknown as boolean })).toEqual({ aiSummaryEnabled: false })
    expect(normalizeTimelineSettings({ aiSummaryEnabled: "true" as unknown as boolean })).toEqual({ aiSummaryEnabled: false })
    expect(normalizeTimelineSettings({})).toEqual({ aiSummaryEnabled: false })
  })

  it("设置对象里只有 AI 摘要开关（保留策略是全局的源库裁剪）", () => {
    expect(Object.keys(DEFAULT_TIMELINE_SETTINGS)).toEqual(["aiSummaryEnabled"])
  })
})

describe("parseTimelineSettingsPatch", () => {
  it("布尔值原样通过", () => {
    expect(parseTimelineSettingsPatch({ aiSummaryEnabled: true })).toEqual({
      patch: { aiSummaryEnabled: true },
      errors: [],
    })
    expect(parseTimelineSettingsPatch({ aiSummaryEnabled: false })).toEqual({
      patch: { aiSummaryEnabled: false },
      errors: [],
    })
  })

  it("非布尔值报错，且不写进补丁", () => {
    for (const value of ["yes", 1, null, undefined]) {
      const { patch, errors } = parseTimelineSettingsPatch({ aiSummaryEnabled: value })
      expect(patch).toEqual({})
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("aiSummaryEnabled")
    }
  })

  it("空 patch / 未知键 = 空补丁（路由层按 empty_patch 400，不静默接受）", () => {
    expect(parseTimelineSettingsPatch({})).toEqual({ patch: {}, errors: [] })
    expect(parseTimelineSettingsPatch({ maxImageCount: 6, avifQuality: 30 })).toEqual({ patch: {}, errors: [] })
  })

  it("非对象入参报错", () => {
    expect(parseTimelineSettingsPatch(null).errors).toEqual(["请求体必须是对象"])
    expect(parseTimelineSettingsPatch("x").errors).toEqual(["请求体必须是对象"])
  })
})

describe("entryIdPrefix", () => {
  it("feed 与 bot 各自的条目前缀", () => {
    expect(entryIdPrefix("abc123")).toBe("entry:abc123:")
    expect(entryIdPrefix("bot:b1")).toBe("entry:bot:b1:")
  })
})
