import { describe, expect, it } from "vitest"
import {
  DEFAULT_TIMELINE_SETTINGS,
  entryIdPrefix,
  looserBoundIso,
  normalizeTimelineSettings,
  parseTimelineSettingsPatch,
  retentionBoundIso,
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
    // 没写过的保底条数走默认（50 = 低频源也有内容可看）
    expect(s.minFeedEntries).toBe(50)
  })

  it("脏值（负数 / 非数字）回退默认，aiSummaryEnabled 只认 true", () => {
    const s = normalizeTimelineSettings({
      windowDays: -1,
      minFeedEntries: "50" as unknown as number,
      aiSummaryEnabled: 1 as unknown as boolean,
    })
    expect(s.windowDays).toBe(DEFAULT_TIMELINE_SETTINGS.windowDays)
    expect(s.minFeedEntries).toBe(DEFAULT_TIMELINE_SETTINGS.minFeedEntries)
    expect(s.aiSummaryEnabled).toBe(false)
  })

  it("图片参数不再是用户设置项：设置对象里只有窗口、保底条数与 AI 开关", () => {
    expect(Object.keys(DEFAULT_TIMELINE_SETTINGS).sort()).toEqual(["aiSummaryEnabled", "minFeedEntries", "windowDays"])
  })
})

describe("parseTimelineSettingsPatch", () => {
  it("合法补丁原样通过", () => {
    const { patch, errors } = parseTimelineSettingsPatch({ windowDays: 30, minFeedEntries: 100, aiSummaryEnabled: true })
    expect(errors).toEqual([])
    expect(patch).toEqual({ windowDays: 30, minFeedEntries: 100, aiSummaryEnabled: true })
  })

  it("越界 / 非整数 / 类型错误逐项报错，且不写进补丁", () => {
    const { patch, errors } = parseTimelineSettingsPatch({
      windowDays: 999,
      minFeedEntries: -1,
      aiSummaryEnabled: "yes",
    })
    expect(Object.keys(patch)).toHaveLength(0)
    expect(errors).toHaveLength(3)
    expect(errors.join()).toContain("windowDays")
    expect(errors.join()).toContain("minFeedEntries")
    expect(errors.join()).toContain("aiSummaryEnabled")
  })

  it("保底条数 0 是合法值（= 关闭，回到纯时间窗口）", () => {
    const { patch, errors } = parseTimelineSettingsPatch({ minFeedEntries: 0 })
    expect(errors).toEqual([])
    expect(patch).toEqual({ minFeedEntries: 0 })
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

/**
 * 保留区间 = 「窗口内 ∨ 该源最新 N 条」。因为复制过滤器只能表达"发布时间 >= 某个值"，
 * "最新 N 条"必须先折算成一个时间下界 —— 这两个纯函数就是那次折算，边界错了会同时影响
 * 「搬什么进来」和「删什么出去」。
 */
describe("looserBoundIso / retentionBoundIso", () => {
  it("取更松（更早）的那个下界；null 表示无下界（最松）", () => {
    expect(looserBoundIso("2025-01-07T00:00:00.000Z", "2025-03-01T00:00:00.000Z"))
      .toBe("2025-01-07T00:00:00.000Z")
    expect(looserBoundIso("2025-03-01T00:00:00.000Z", "2025-01-07T00:00:00.000Z"))
      .toBe("2025-01-07T00:00:00.000Z")
    expect(looserBoundIso(null, "2025-01-07T00:00:00.000Z")).toBeNull()
    expect(looserBoundIso("2025-01-07T00:00:00.000Z", null)).toBeNull()
  })

  it("没开保底条数 = 纯窗口（keepFrom 为 null 不能被当成「全留」）", () => {
    expect(retentionBoundIso({
      windowStart: "2026-10-09T00:00:00.000Z",
      minEntries: 0,
      keepFromIso: null,
    })).toBe("2026-10-09T00:00:00.000Z")
  })

  it("开了保底条数且源里够 N 条：取更松的那个（低频源会因此一直回填到第 N 新）", () => {
    expect(retentionBoundIso({
      windowStart: "2026-10-09T00:00:00.000Z",
      minEntries: 50,
      keepFromIso: "2026-09-27T16:00:00.000Z",
    })).toBe("2026-09-27T16:00:00.000Z")
    // 高频源：第 N 新就在窗口内 → 窗口说了算（"高频源继续按时间窗口过滤"）
    expect(retentionBoundIso({
      windowStart: "2026-10-09T00:00:00.000Z",
      minEntries: 50,
      keepFromIso: "2026-10-11T00:00:00.000Z",
    })).toBe("2026-10-09T00:00:00.000Z")
  })

  it("开了保底条数但源里不足 N 条：无下界 = 这个源一篇都不许丢", () => {
    expect(retentionBoundIso({
      windowStart: "2026-10-09T00:00:00.000Z",
      minEntries: 50,
      keepFromIso: null,
    })).toBeNull()
  })

  it("窗口不限时间：无下界（保底条数不额外要求什么）", () => {
    expect(retentionBoundIso({ windowStart: null, minEntries: 50, keepFromIso: null })).toBeNull()
    expect(retentionBoundIso({ windowStart: null, minEntries: 0, keepFromIso: null })).toBeNull()
  })
})
