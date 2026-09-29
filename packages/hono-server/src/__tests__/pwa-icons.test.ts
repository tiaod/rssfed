import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { ICON_SPECS, type IconSpecKey } from "../pwa/manifest"
import { defaultIconSvg, parseHexColor, readableForeground, renderIconPng } from "../pwa/render"

/** 造一张纯色 PNG 源图（模拟管理员上传的方形图，或横版 logo） */
async function solidPng(
  width: number,
  height: number,
  color: { r: number, g: number, b: number, alpha?: number } = { r: 255, g: 0, b: 0 }
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { alpha: 1, ...color }
    }
  }).png().toBuffer()
}

/** 解码成 RGBA 原始像素，提供按坐标取色（避免每取一个点就重新解码一次） */
async function decode(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    at(x: number, y: number) {
      const offset = (y * info.width + x) * info.channels
      return {
        r: data[offset]!,
        g: data[offset + 1]!,
        b: data[offset + 2]!,
        a: data[offset + 3]!
      }
    }
  }
}

const ALL_SPECS = Object.keys(ICON_SPECS) as IconSpecKey[]

describe("renderIconPng：输出尺寸必须与 manifest 声明一致", () => {
  // 这是最容易踩且最难排查的一条：Chrome 会丢弃 sizes 与实际像素不符的图标，
  // 表现为「manifest 看起来没问题，但就是装不上」。
  it.each(ALL_SPECS)("规格 %s 输出真实像素等于声明尺寸", async (specKey) => {
    const spec = ICON_SPECS[specKey]
    const png = await renderIconPng(defaultIconSvg("#00c16a"), specKey, "#00c16a")
    const meta = await sharp(png).metadata()

    expect(meta.format).toBe("png")
    expect(meta.width).toBe(spec.size)
    expect(meta.height).toBe(spec.size)
  })

  it("横版源图（400x100）经 contain 后仍是正方形，不拉伸变形", async () => {
    const wide = await solidPng(400, 100)
    const png = await renderIconPng(wide, "512", "#ffffff")
    const img = await decode(png)

    expect(img.width).toBe(512)
    expect(img.height).toBe(512)
    // contain 后图形高度 = 100/400*512 = 128，居中于 y ∈ [192, 320]
    expect(img.at(256, 256).r).toBeGreaterThan(200)
    // 上下留白保持透明，说明没有被强行拉伸填满
    expect(img.at(256, 10).a).toBe(0)
    expect(img.at(256, 501).a).toBe(0)
  })
})

describe("renderIconPng：maskable 安全区", () => {
  it("图形缩进中心安全区，四周是不透明底色", async () => {
    const red = await solidPng(400, 400)
    const png = await renderIconPng(red, "maskable-512", "#0000ff")
    const img = await decode(png)

    // 四角必须是底色：Android 会按自己的形状裁切，贴边图形会被切掉
    // 显式标注坐标元组：字面量数组会被推成 number[][]，解构出的 x/y 是 number | undefined
    const corners: Array<[number, number]> = [[0, 0], [511, 0], [0, 511], [511, 511]]
    for (const [x, y] of corners) {
      const px = img.at(x, y)
      expect(px.b).toBe(255)
      expect(px.a).toBe(255)
    }

    // 中心是图形本体
    expect(img.at(256, 256).r).toBeGreaterThan(200)

    // 安全区边界：512 * 0.8 = 410，居中偏移 51，故 x=40 仍是底色、x=70 已是图形
    expect(img.at(40, 256).b).toBe(255)
    expect(img.at(70, 256).r).toBeGreaterThan(200)
  })
})

describe("renderIconPng：不透明底（iOS 主屏幕图标）", () => {
  it("源图带透明区域时整图仍完全不透明，并把透明处压成底色", async () => {
    // 默认图标的圆角外就是透明区域，正好用来验证 flatten
    const png = await renderIconPng(defaultIconSvg("#00c16a"), "apple-touch-180", "#00c16a")
    const img = await decode(png)

    expect(img.width).toBe(180)
    const corners: Array<[number, number]> = [[0, 0], [179, 0], [0, 179], [179, 179], [90, 90]]
    for (const [x, y] of corners) {
      expect(img.at(x, y).a).toBe(255)
    }
    // 圆角外的像素应被压成底色 #00c16a
    expect(img.at(0, 0)).toMatchObject({ r: 0, g: 193, b: 106 })
  })

  it("普通图标保留透明背景（不强制铺底）", async () => {
    const png = await renderIconPng(defaultIconSvg("#00c16a"), "192", "#00c16a")
    const img = await decode(png)

    expect(img.at(0, 0).a).toBe(0)
    expect(img.at(96, 96).a).toBe(255)
  })
})

describe("defaultIconSvg：不依赖字体的内置兜底图形", () => {
  it("能渲染出有效 PNG（纯几何路径，缺字体也不会整块空白）", async () => {
    const png = await renderIconPng(defaultIconSvg("#00c16a"), "512", "#00c16a")
    const meta = await sharp(png).metadata()
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(512)
  })

  it("浅色底用深色前景、深色底用白色前景", () => {
    expect(readableForeground("#ffffff")).toBe("#1f2937")
    expect(readableForeground("#000000")).toBe("#ffffff")
    // #00c16a 感知亮度约 0.49，属于「深底」→ 白色前景
    expect(readableForeground("#00c16a")).toBe("#ffffff")
    expect(defaultIconSvg("#ffffff")).toContain("#1f2937")
    expect(defaultIconSvg("#000000")).toContain("#ffffff")
  })

  it("主题色非法时回退白色底，不把脏值写进 SVG", () => {
    const svg = defaultIconSvg("not-a-color")
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).not.toContain("not-a-color")
  })
})

describe("parseHexColor", () => {
  it("解析 #rrggbb", () => {
    expect(parseHexColor("#00c16a")).toEqual({ r: 0, g: 193, b: 106 })
  })

  it("#rgb 归一化后再解析", () => {
    expect(parseHexColor("#0cf")).toEqual({ r: 0, g: 204, b: 255 })
  })

  it("空值或非法值回退白色", () => {
    expect(parseHexColor(null)).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHexColor("red")).toEqual({ r: 255, g: 255, b: 255 })
  })
})
