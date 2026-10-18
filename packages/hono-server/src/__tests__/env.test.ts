import { afterEach, describe, expect, it } from "vitest"
import { envInt, formatDuration } from "../env"

/** 每个用例用自己的变量名，afterEach 里删掉，避免互相污染 */
const used = new Set<string>()
function setEnv(name: string, value: string | undefined): void {
  used.add(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  for (const name of used) delete process.env[name]
  used.clear()
})

describe("envInt：数值型环境变量的统一兜底", () => {
  it("空串回退默认值（?? 挡不住空串：会 parse 出 NaN）", () => {
    setEnv("TEST_INT_X", "")
    expect(envInt("TEST_INT_X", 15)).toBe(15)
  })

  it("未设置 / 非数字 / 小数写法非法时回退默认", () => {
    setEnv("TEST_INT_X", undefined)
    expect(envInt("TEST_INT_X", 42)).toBe(42)
    setEnv("TEST_INT_X", "abc")
    expect(envInt("TEST_INT_X", 42)).toBe(42)
    setEnv("TEST_INT_X", "900000ms")
    expect(envInt("TEST_INT_X", 42)).toBe(42)
  })

  it("合法值原样返回", () => {
    setEnv("TEST_INT_X", "900000")
    expect(envInt("TEST_INT_X", 1)).toBe(900000)
  })

  it("小于 min 时回退（默认 min=1，挡住 0 与负数）", () => {
    setEnv("TEST_INT_X", "0")
    expect(envInt("TEST_INT_X", 15)).toBe(15)
    setEnv("TEST_INT_X", "-5")
    expect(envInt("TEST_INT_X", 15)).toBe(15)
  })

  it("显式 min=0 时允许 0（如冷却窗口 0=关闭）", () => {
    setEnv("TEST_INT_X", "0")
    expect(envInt("TEST_INT_X", 300_000, { min: 0 })).toBe(0)
  })

  it("超过 max 时回退（如 AVIF 质量上限 100）", () => {
    setEnv("TEST_INT_X", "200")
    expect(envInt("TEST_INT_X", 45, { min: 0, max: 100 })).toBe(45)
  })
})

describe("formatDuration", () => {
  it("整小时/整分钟/整秒用紧凑单位，其余保留毫秒", () => {
    expect(formatDuration(6 * 60 * 60 * 1000)).toBe("6h")
    expect(formatDuration(15 * 60 * 1000)).toBe("15m")
    expect(formatDuration(30 * 1000)).toBe("30s")
    expect(formatDuration(90_000)).toBe("90s")
    expect(formatDuration(1234)).toBe("1234ms")
  })
})
