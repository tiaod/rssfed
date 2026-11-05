import { beforeEach, describe, expect, it } from "vitest"
import type { PwaSettingsRow } from "../pwa/manifest"
import { clearFaviconCache, getFaviconIco } from "../pwa/favicon"

/** 全空配置：图标源回退内置默认图形，无需数据库与存储层 */
function row(): PwaSettingsRow {
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
    updatedAt: new Date("2026-01-01T00:00:00Z")
  }
}

/** ICO 文件头：reserved 2 字节 + type 2 字节 + 图像数量 2 字节 */
function readIcoHeader(ico: Buffer) {
  return {
    reserved: ico.readUInt16LE(0),
    type: ico.readUInt16LE(2),
    count: ico.readUInt16LE(4)
  }
}

/** 第 index 个目录条目的宽高（字节值，0 表示 256） */
function readIcoEntrySize(ico: Buffer, index: number) {
  const offset = 6 + index * 16
  return {
    // 目录里 0 表示 256
    width: ico.readUInt8(offset) || 256,
    height: ico.readUInt8(offset + 1) || 256
  }
}

describe("getFaviconIco", () => {
  beforeEach(() => clearFaviconCache())

  it("输出合法 ICO，并包含 16/32/48 三种尺寸", async () => {
    const ico = await getFaviconIco(row())

    expect(readIcoHeader(ico)).toEqual({ reserved: 0, type: 1, count: 3 })
    expect([0, 1, 2].map(i => readIcoEntrySize(ico, i))).toEqual([
      { width: 16, height: 16 },
      { width: 32, height: 32 },
      { width: 48, height: 48 }
    ])
  })

  it("同一图标源命中进程内缓存，不重复编码", async () => {
    const first = await getFaviconIco(row())
    const second = await getFaviconIco(row())
    expect(second).toBe(first)
  })
})
