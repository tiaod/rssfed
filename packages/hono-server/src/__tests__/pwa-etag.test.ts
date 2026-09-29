import { describe, expect, it } from "vitest"
import { etagMatches } from "../pwa/etag"

const ETAG = 'W/"1735689600000-abc123def456"'

describe("etagMatches：If-None-Match 弱比较", () => {
  it("没有该请求头时不命中（走完整响应）", () => {
    expect(etagMatches(undefined, ETAG)).toBe(false)
    expect(etagMatches("", ETAG)).toBe(false)
  })

  it("逐字相同则命中", () => {
    expect(etagMatches(ETAG, ETAG)).toBe(true)
  })

  it("忽略弱校验前缀 W/", () => {
    // 浏览器可能把 W/"x" 回传成 "x"，两者语义上等价
    expect(etagMatches('"1735689600000-abc123def456"', ETAG)).toBe(true)
    expect(etagMatches('W/"1735689600000-abc123def456"', '"1735689600000-abc123def456"')).toBe(true)
  })

  it("允许多个候选项，命中其中之一即可", () => {
    expect(etagMatches('W/"old", W/"older", ' + ETAG, ETAG)).toBe(true)
    expect(etagMatches(`W/"old",${ETAG}`, ETAG)).toBe(true)
  })

  it("候选项都不匹配则不命中（配置已变，需下发新内容）", () => {
    expect(etagMatches('W/"old", W/"older"', ETAG)).toBe(false)
  })

  it("* 表示任何已存在的表示都命中", () => {
    expect(etagMatches("*", ETAG)).toBe(true)
    expect(etagMatches(" * ", ETAG)).toBe(true)
  })

  it("不接受前缀相同的伪造值（必须是完整匹配）", () => {
    expect(etagMatches('W/"1735689600000"', ETAG)).toBe(false)
    expect(etagMatches('W/"1735689600000-abc123def456-extra"', ETAG)).toBe(false)
  })
})
