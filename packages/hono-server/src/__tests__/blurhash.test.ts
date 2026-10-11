import { describe, expect, it } from "vitest"
import sharp from "sharp"
import { blurhashFromImage, encodeBlurhash } from "../images/blurhash"

/**
 * 与官方 `blurhash@2.0.5` 的输出逐字符对齐的用例。
 *
 * 这些字符串是**参考实现算出来的**（不是本地实现跑一遍存下来的），所以断言相等就等于
 * 「编码结果能被任何标准解码器解析」，客户端的解码实现也拿同一批用例对齐
 * （见 nuxt-client 的 `app/__tests__/utils/blurhash.test.ts`）。
 */
const INTEROP_CASES = [
  { name: "纯色（青绿）32×24", kind: "solid", rgb: [32, 128, 160], width: 32, height: 24, blurhash: "L43yGppefQpepyflfQflfQfQfQfQ" },
  { name: "水平黑白渐变 32×16", kind: "hgradient", rgb: [0, 0, 0], width: 32, height: 16, blurhash: "LEHoI600~qM{-;IUofayfQfQfQfQ" },
  { name: "纯红 16×16", kind: "solid", rgb: [255, 0, 0], width: 16, height: 16, blurhash: "LKTI:j|cfQ|c|co1fQo1fQfQfQfQ" },
] as const

/** 造与 fixtures 完全一致的 RGBA 像素（纯色 / 水平渐变） */
function buildPixels(spec: (typeof INTEROP_CASES)[number]): Uint8Array {
  const pixels = new Uint8Array(spec.width * spec.height * 4)
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const offset = (y * spec.width + x) * 4
      let r: number, g: number, b: number
      if (spec.kind === "hgradient") {
        const t = x / (spec.width - 1)
        r = Math.round(t * 255)
        g = r
        b = r
      } else {
        ;[r, g, b] = spec.rgb
      }
      pixels[offset] = r
      pixels[offset + 1] = g
      pixels[offset + 2] = b
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

describe("encodeBlurhash", () => {
  for (const spec of INTEROP_CASES) {
    it(`${spec.name}：与参考实现输出逐字符一致`, () => {
      const pixels = buildPixels(spec)
      expect(encodeBlurhash(pixels, spec.width, spec.height)).toBe(spec.blurhash)
    })
  }

  it("分量数决定字符串长度（4 + 2·X·Y）", () => {
    const pixels = buildPixels(INTEROP_CASES[0])
    expect(encodeBlurhash(pixels, 32, 24, 4, 3)).toHaveLength(4 + 2 * 4 * 3)
    expect(encodeBlurhash(pixels, 32, 24, 3, 3)).toHaveLength(4 + 2 * 3 * 3)
  })

  it("像素数与尺寸不符时抛错（错误输入不该静默产出垃圾字符串）", () => {
    expect(() => encodeBlurhash(new Uint8Array(16), 4, 4)).toThrow()
    expect(() => encodeBlurhash(new Uint8Array(4 * 4 * 4), 4, 4, 0, 3)).toThrow()
  })
})

describe("blurhashFromImage", () => {
  it("sharp 解码缩略后的结果与参考实现对同一张图一致", async () => {
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 32, g: 128, b: 160 } },
    }).png().toBuffer()
    expect(await blurhashFromImage(png)).toBe("L43yGppefQpepyflfQflfQfQfQfQ")
  })

  it("大图先缩到 32px 以内再编码，成本与源图大小无关", async () => {
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer()
    const hash = await blurhashFromImage(png)
    // 4×3 分量的字符串长度固定为 28，与源图尺寸无关
    expect(hash).toHaveLength(28)
    // 直流分量（字符串第 3-6 位）应与参考实现的纯红用例落在同一档 —— 缩略不改变平均色
    const redFixture = INTEROP_CASES.find(c => c.name.includes("纯红"))!
    expect(hash?.slice(2, 6)).toBe(redFixture.blurhash.slice(2, 6))
  })

  it("不是图片时返回 null（占位图退化，不影响抓取）", async () => {
    expect(await blurhashFromImage(Buffer.from("not an image"))).toBeNull()
  })
})
