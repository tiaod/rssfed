import http from "node:http"
import { afterAll, describe, expect, it } from "vitest"

/**
 * SSRF 地址闸门。
 *
 * 设计参考 Miniflux 的 `Dialer.Control`：校验必须发生在「已解析出 IP、尚未建连」那一刻，
 * 这样被检查的 IP 与真正连接的 IP 是同一个，DNS rebinding 绕不过去。Node 里对应的位置是
 * `lookup` 回调（见 rss/ssrf-guard.ts 的头部注释）。
 *
 * 这个文件钉住三件事：
 *  1. 常规私网/保留地址全部拦下；
 *  2. **把 IPv4 藏在 IPv6 里的写法也拦下**（`BlockList` 自己认不出 `::ffff:127.0.0.1`，
 *     实测 check 返回 false，所以必须单独处理）；
 *  3. 真正建立连接时，`lookup` 钩子确实生效（而不是只有个没人调用的函数）。
 *
 * ⚠️ 全局 vitest 配置里开着 `SSRF_GUARD_ALLOW_PRIVATE=1`（其它测试要靠 127.0.0.1 的
 * 临时服务），所以这里在导入被测模块**之前**把它清掉，并在文件末尾恢复 —— 否则本文件
 * 会在一个"什么都放行"的配置下自证清白。
 */

const savedFlag = process.env.SSRF_GUARD_ALLOW_PRIVATE
delete process.env.SSRF_GUARD_ALLOW_PRIVATE

const { assertFetchableUrl, guardedHttpAgent, isBlockedIp } = await import("../rss/ssrf-guard")

afterAll(() => {
  if (savedFlag === undefined) delete process.env.SSRF_GUARD_ALLOW_PRIVATE
  else process.env.SSRF_GUARD_ALLOW_PRIVATE = savedFlag
})

describe("isBlockedIp", () => {
  it.each([
    ["127.0.0.1", "环回"],
    ["10.1.2.3", "私网 A"],
    ["172.16.5.4", "私网 B"],
    ["192.168.1.1", "私网 C"],
    ["169.254.169.254", "链路本地 / 云元数据"],
    ["100.64.0.1", "CGNAT（RFC 6598）"],
    ["0.0.0.0", "未指定"],
    ["240.0.0.1", "保留"],
    ["192.0.0.192", "Oracle 元数据"],
    ["198.18.0.1", "基准测试段"],
  ])("拦截 %s（%s）", (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each([
    ["::1", "IPv6 环回"],
    ["fc00::1", "唯一本地地址"],
    ["fe80::1", "IPv6 链路本地"],
    ["ff02::1", "IPv6 组播"],
  ])("拦截 %s（%s）", (ip) => {
    expect(isBlockedIp(ip)).toBe(true)
  })

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["2606:4700:4700::1111"],
  ])("放行公网地址 %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false)
  })

  it("拦截把 IPv4 藏进 IPv6 的写法", () => {
    // BlockList 直接 check 这几类会返回 false（实测），所以必须拆出内嵌 IPv4 再判
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true)
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true) // 127.0.0.1 的十六进制写法
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true) // NAT64 映射到 127.0.0.1
    expect(isBlockedIp("64:ff9b::a00:1")).toBe(true) // NAT64 映射到 10.0.0.1
    expect(isBlockedIp("2002:7f00:1::")).toBe(true) // 6to4 内嵌 127.0.0.1
  })

  it("不是 IP 字面量时按不安全处理（避免静默放行）", () => {
    expect(isBlockedIp("example.com")).toBe(true)
  })
})

describe("assertFetchableUrl", () => {
  it("拒绝直接写内网 IP 的地址", async () => {
    // 这类请求不会走 lookup（Node 直接把 IP 拿去 connect），必须在这里挡
    await expect(assertFetchableUrl("http://127.0.0.1:5984/")).rejects.toThrow(/内网|保留/)
    await expect(assertFetchableUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/内网|保留/)
    await expect(assertFetchableUrl("http://[::1]:5984/")).rejects.toThrow(/内网|保留/)
  })

  it("拒绝 localhost 之类会解析到环回的域名", async () => {
    await expect(assertFetchableUrl("http://localhost:1200/")).rejects.toThrow(/内网|保留/)
  })

  it("拒绝非 http/https 协议", async () => {
    await expect(assertFetchableUrl("file:///etc/passwd")).rejects.toThrow(/http/)
    await expect(assertFetchableUrl("ftp://example.com/x")).rejects.toThrow(/http/)
  })

  it("放行公网地址", async () => {
    // 不真正联网，只验证不抛错（8.8.8.8 是 IP 字面量，不触发 DNS）
    await expect(assertFetchableUrl("https://8.8.8.8/feed.xml")).resolves.toBeUndefined()
  })
})

describe("guardedHttpAgent", () => {
  it("真正建连时拦下内网目标（lookup 钩子生效）", async () => {
    // 这是最关键的一条：证明防护接在了真实连接路径上，而不只是一个没人调用的函数
    const error = await new Promise<Error | null>((resolve) => {
      const req = http.get("http://localhost:3001/api/health", { agent: guardedHttpAgent }, (res) => {
        res.resume()
        resolve(null)
      })
      req.on("error", (err) => resolve(err))
      req.setTimeout(3000, () => {
        req.destroy()
        resolve(new Error("timeout"))
      })
    })

    expect(error).toBeTruthy()
    expect(error?.message).toMatch(/内网|保留/)
  })
})
