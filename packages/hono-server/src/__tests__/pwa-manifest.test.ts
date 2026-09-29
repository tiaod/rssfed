import { describe, expect, it } from "vitest"
import {
  DEFAULT_APP_DESCRIPTION,
  DEFAULT_APP_NAME,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_THEME_COLOR,
  DISPLAY_MODES,
  ICON_SPECS,
  buildManifest,
  isIconSpecKey,
  normalizeHexColor,
  resolvePwaConfig,
  settingsVersion,
  type PwaSettingsRow
} from "../pwa/manifest"

/** 造一行站点配置，默认全空（即「管理员什么都没配」） */
function row(overrides: Partial<PwaSettingsRow> = {}): PwaSettingsRow {
  return {
    siteTitle: null,
    description: null,
    primaryColor: null,
    pwaShortName: null,
    pwaDisplay: null,
    pwaThemeColor: null,
    pwaBackgroundColor: null,
    pwaIconUrl: null,
    pwaIconAttachmentId: null,
    logoUrl: null,
    logoAttachmentId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  }
}

describe("normalizeHexColor", () => {
  it("把 #rgb 展开为 #rrggbb 并统一小写", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc")
    expect(normalizeHexColor("#00C16A")).toBe("#00c16a")
  })

  it("非法或空值返回 null（供调用方回退默认色）", () => {
    expect(normalizeHexColor("#12345")).toBeNull()
    expect(normalizeHexColor("red")).toBeNull()
    expect(normalizeHexColor("")).toBeNull()
    expect(normalizeHexColor(null)).toBeNull()
    expect(normalizeHexColor(undefined)).toBeNull()
  })
})

describe("isIconSpecKey", () => {
  it("只接受规格表里的 key", () => {
    expect(isIconSpecKey("512")).toBe(true)
    expect(isIconSpecKey("maskable-512")).toBe(true)
    expect(isIconSpecKey("apple-touch-180")).toBe(true)
    // 防止任意值被当成规格去渲染：路径穿越、超大尺寸等都挡在这里
    expect(isIconSpecKey("4096")).toBe(false)
    expect(isIconSpecKey("../sw")).toBe(false)
    expect(isIconSpecKey("")).toBe(false)
    // Object.hasOwn 而非 in，避免命中原型链上的属性名
    expect(isIconSpecKey("toString")).toBe(false)
  })
})

describe("resolvePwaConfig：逐级回退", () => {
  it("全空配置回退内置默认值", () => {
    const config = resolvePwaConfig(row())
    expect(config.name).toBe(DEFAULT_APP_NAME)
    expect(config.shortName).toBe(DEFAULT_APP_NAME)
    expect(config.description).toBe(DEFAULT_APP_DESCRIPTION)
    expect(config.themeColor).toBe(DEFAULT_THEME_COLOR)
    expect(config.backgroundColor).toBe(DEFAULT_BACKGROUND_COLOR)
    expect(config.display).toBe("standalone")
    expect(config.hasDedicatedIcon).toBe(false)
  })

  it("站点标题同时作为 name 与 short_name，并按 12 字符截断", () => {
    const config = resolvePwaConfig(row({ siteTitle: "我的超长站点名称会超过十二个字符" }))
    expect(config.name).toBe("我的超长站点名称会超过十二个字符")
    expect(config.shortName).toBe("我的超长站点名称会超过十")
    expect([...config.shortName].length).toBe(12)
  })

  it("显式配置的短名优先于站点标题，且放宽到 30 字符", () => {
    const config = resolvePwaConfig(row({
      siteTitle: "很长的站点标题",
      pwaShortName: "自定义短名"
    }))
    expect(config.name).toBe("很长的站点标题")
    expect(config.shortName).toBe("自定义短名")
  })

  it("主题色回退链：PWA 专项色 → 站点主色 → 内置默认", () => {
    const fromPrimary = resolvePwaConfig(row({ primaryColor: "#10B981" }))
    expect(fromPrimary.themeColor).toBe("#10b981")
    expect(fromPrimary.backgroundColor).toBe("#10b981")

    const overridden = resolvePwaConfig(row({
      primaryColor: "#10B981",
      pwaThemeColor: "#111111",
      pwaBackgroundColor: "#222222"
    }))
    expect(overridden.themeColor).toBe("#111111")
    expect(overridden.backgroundColor).toBe("#222222")
  })

  it("数据库里的脏颜色不会带进 manifest", () => {
    const config = resolvePwaConfig(row({
      primaryColor: "javascript:alert(1)",
      pwaThemeColor: "not-a-color",
      pwaBackgroundColor: "#12"
    }))
    expect(config.themeColor).toBe(DEFAULT_THEME_COLOR)
    expect(config.backgroundColor).toBe(DEFAULT_BACKGROUND_COLOR)
  })

  it("display 非法值回退 standalone，合法值保留", () => {
    expect(resolvePwaConfig(row({ pwaDisplay: "fullscreen" })).display).toBe("fullscreen")
    expect(resolvePwaConfig(row({ pwaDisplay: "hacked" })).display).toBe("standalone")
    expect(resolvePwaConfig(row({ pwaDisplay: "" })).display).toBe("standalone")
    // 白名单本身就是 manifest 的合法取值集合
    for (const mode of DISPLAY_MODES) {
      expect(resolvePwaConfig(row({ pwaDisplay: mode })).display).toBe(mode)
    }
  })

  it("有独立方形图标时标记 hasDedicatedIcon", () => {
    expect(resolvePwaConfig(row({ pwaIconUrl: "https://cdn.example.com/i.png" })).hasDedicatedIcon).toBe(true)
    expect(resolvePwaConfig(row({ logoUrl: "https://cdn.example.com/logo.svg" })).hasDedicatedIcon).toBe(false)
  })
})

describe("buildManifest", () => {
  it("图标声明与 ICON_SPECS 严格对应，且不含 iOS 专用的 apple-touch", () => {
    const manifest = buildManifest(resolvePwaConfig(row()))
    const bySizes = manifest.icons.map(i => `${i.sizes}:${i.purpose}`)

    expect(bySizes).toEqual(["192x192:any", "512x512:any", "512x512:maskable"])
    expect(manifest.icons.every(i => i.type === "image/png")).toBe(true)
    // apple-touch-180 走 <link rel="apple-touch-icon">，混进 manifest 会让 Android 也挑它
    expect(manifest.icons.some(i => i.src.includes("apple-touch"))).toBe(false)
  })

  it("每个 sizes 都能在 ICON_SPECS 里找到同尺寸的规格（防止声明与输出脱节）", () => {
    const manifest = buildManifest(resolvePwaConfig(row()))
    for (const icon of manifest.icons) {
      const key = icon.src.split("/").pop()!.replace(".png", "").split("?")[0]!
      // 用 if-throw 而不是 expect(...).toBe(true)：expect 不是类型守卫，收窄不了 key，
      // 后面的 ICON_SPECS[key] 会因 string 索引报 TS7053；顺带失败信息也更具体
      if (!isIconSpecKey(key)) throw new Error(`manifest 声明了未知规格的图标：${icon.src}`)
      expect(icon.sizes).toBe(`${ICON_SPECS[key].size}x${ICON_SPECS[key].size}`)
      expect(icon.purpose).toBe(ICON_SPECS[key].purpose)
    }
  })

  it("图标 URL 是站内绝对路径并带版本号", () => {
    const manifest = buildManifest(resolvePwaConfig(row()))
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/api/site-settings/icon/")).toBe(true)
      expect(icon.src).toContain("?v=")
    }
  })

  it("输出 PWA 必需字段", () => {
    const manifest = buildManifest(resolvePwaConfig(row({
      siteTitle: "RSSFed 演示",
      description: "自建 RSS 阅读器",
      primaryColor: "#0ea5e9",
      pwaDisplay: "minimal-ui"
    })))

    expect(manifest).toMatchObject({
      id: "/",
      name: "RSSFed 演示",
      description: "自建 RSS 阅读器",
      start_url: "/",
      scope: "/",
      display: "minimal-ui",
      theme_color: "#0ea5e9",
      background_color: "#0ea5e9",
      lang: "zh-CN"
    })
  })

  it("可被 JSON 序列化（路由直接 JSON.stringify 下发）", () => {
    const manifest = buildManifest(resolvePwaConfig(row()))
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
  })
})

describe("settingsVersion：缓存失效的依据", () => {
  it("配置更新时间变化则版本变化", () => {
    const a = settingsVersion(row({ updatedAt: new Date("2026-01-01T00:00:00Z") }))
    const b = settingsVersion(row({ updatedAt: new Date("2026-01-02T00:00:00Z") }))
    expect(a).not.toBe(b)
  })

  it("换图标或换底色则版本变化", () => {
    const base = settingsVersion(row())
    expect(settingsVersion(row({ pwaIconAttachmentId: "att-1" }))).not.toBe(base)
    expect(settingsVersion(row({ logoAttachmentId: "att-2" }))).not.toBe(base)
    expect(settingsVersion(row({ primaryColor: "#ff0000" }))).not.toBe(base)
  })

  it("只含 URL 安全字符（要拼进 query 与 ETag）", () => {
    const version = settingsVersion(row({ pwaIconUrl: "https://cdn.example.com/a b?c=d&e" }))
    expect(version).toMatch(/^[a-zA-Z0-9-]+$/)
  })
})
