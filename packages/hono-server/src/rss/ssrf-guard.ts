import net from "node:net"
import dns from "node:dns"
import http from "node:http"
import https from "node:https"

/**
 * 抓取目标的地址闸门（SSRF 防护）。
 *
 * ## 为什么不能用「先解析、再请求」的写法
 *
 * 最常见的 SSRF 防护是「`dns.lookup()` 拿到 IP → 判断是否私网 → 再发请求」。它能被
 * DNS rebinding / TOCTOU 绕过：攻击者让同一个域名第一次解析到公网 IP（通过检查），
 * 第二次解析到 `127.0.0.1`（真正连过去）。两次解析之间没有任何约束。
 *
 * 参考 Miniflux 的做法（`internal/reader/fetcher/request_builder.go` 的 `Dialer.Control`）：
 * 校验必须发生在**「已经解析出 IP、还没建立 TCP 连接」**的那一刻 —— 这样「被检查的 IP」
 * 与「实际连接的 IP」是同一个值，绕不过去。
 *
 * Go 里那个钩子是 `net.Dialer.Control`；Node 里对应的位置是 **`net.Socket.connect()` 内部的
 * `lookup` 回调**：`lookup` 返回哪个 IP，socket 就连哪个 IP。所以把校验塞进 `lookup` 即可，
 * 效果等同，且不需要引入任何第三方依赖。
 *
 * ## 两个必须单独处理的绕过点（都是实测过的）
 *
 * 1. **直接写 IP 时不会走 `lookup`**（`http://127.0.0.1/`）。这类请求由
 *    `assertFetchableUrl()` 在发起前拦住 —— 好在它不涉及 DNS，没有 TOCTOU 问题。
 * 2. **`BlockList` 不认 IPv4-mapped IPv6**：`::ffff:127.0.0.1` 拿去 `check(..., "ipv6")`
 *    返回 false。所以判断前必须先把内嵌的 IPv4 抽出来再判（见 `isBlockedIp`）。
 *
 * ## 与本地 RSSHub 的关系
 *
 * 校验只作用于**用户提交的原始 URL**。`rewriteRssHubUrl()` 把公共实例改写成
 * `RSSHUB_BASE_URL`（通常是 `localhost:1200`）之后的结果**不再经过这里** —— 那是运维的
 * 可信配置，不是用户输入。见 `fetchFeed` 的调用方式。
 */

/**
 * 禁止访问的网段。
 *
 * 大部分直接来自 RFC（1918 私网、6598 CGNAT、4193 ULA、3927 链路本地），另一部分是
 * 云环境的「元数据地址」—— 那些 IP 在公网视角下是普通地址，但在云主机内指向凭证服务。
 * 清单对齐 Miniflux 的 `nonPublicIPPrefixes` 与 `isNonPublicAddr`，避免漏网。
 */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "This network"（RFC 6890）
  ["10.0.0.0", 8], // 私网 A
  ["100.64.0.0", 10], // RFC 6598 运营商级 NAT（云上常见）
  ["127.0.0.0", 8], // 环回
  ["169.254.0.0", 16], // 链路本地（含 AWS/GCP/Azure 的 169.254.169.254 元数据）
  ["168.63.129.16", 32], // Azure 虚拟 IP（wire server）
  ["172.16.0.0", 12], // 私网 B
  ["192.0.0.192", 32], // Oracle Cloud 元数据
  ["192.168.0.0", 16], // 私网 C
  ["198.18.0.0", 15], // 基准测试保留段
  ["240.0.0.0", 4], // 保留 + 广播
]

const BLOCKED_V6: [string, number][] = [
  ["::", 128], // 未指定
  ["::1", 128], // 环回
  ["::", 96], // 已废弃的 IPv4 兼容地址（RFC 4291）
  ["fc00::", 7], // 唯一本地地址（ULA，RFC 4193）
  ["fe80::", 10], // 链路本地单播
  ["fec0::", 10], // 站点本地（已废弃）
  ["ff00::", 8], // 组播
]

/**
 * 可信端点：运维显式配置的抓取目标（目前是 RSSHUB_BASE_URL 指向的自建实例）。
 *
 * 为什么需要：`rewriteRssHubUrl()` 会把 `rsshub.app` 改写成 `RSSHUB_BASE_URL`，
 * 而后者通常是 `localhost:1200` / `rsshub:1200`（容器内）。若 agent 层一律拦私网，
 * **本地 RSSHub 上的所有源会一起失效** —— 这是运维的显式配置，不是用户输入，
 * 信任级别与用户提交的 URL 不同（对齐 Miniflux 的 trusted-proxy 豁免思路）。
 *
 * 注意豁免只作用于「改写产物」，用户自己填 `http://127.0.0.1/` 仍然被
 * `assertFetchableUrl()` 拦在发请求之前，两者不冲突。
 */
const trustedEndpoints = new Set<string>()

/** 登记一个可信抓取端点（host[:port]）；传空则忽略 */
export function allowTrustedEndpoint(urlOrHost: string | undefined | null): void {
  if (!urlOrHost) return
  try {
    const parsed = urlOrHost.includes("://") ? new URL(urlOrHost) : new URL(`http://${urlOrHost}`)
    trustedEndpoints.add(`${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`)
    trustedEndpoints.add(parsed.hostname.toLowerCase())
  } catch {
    // 配置写错不该让进程起不来：忽略，后续请求会以普通抓取失败的形式暴露
  }
}

/** 该 host（可带端口）是否属于可信端点 */
function isTrustedHost(hostname: string, port?: string | number): boolean {
  const host = hostname.toLowerCase()
  if (trustedEndpoints.has(host)) return true
  if (port !== undefined && port !== "") return trustedEndpoints.has(`${host}:${port}`)
  return false
}

/**
 * 环境级总开关：`SSRF_GUARD_ALLOW_PRIVATE=1` 时放行所有内网地址。
 *
 * 只给**测试**和服务端自动化用（单测大量依赖 `127.0.0.1` 的临时 HTTP 服务）。
 * 生产不要开 —— 开了等于这一层防护不存在，对齐 Miniflux 的
 * `FETCHER_ALLOW_PRIVATE_NETWORKS`（默认关闭）。
 */
const ALLOW_PRIVATE = process.env.SSRF_GUARD_ALLOW_PRIVATE === "1"

const blockList = new net.BlockList()
for (const [addr, prefix] of BLOCKED_V4) blockList.addSubnet(addr, prefix, "ipv4")
for (const [addr, prefix] of BLOCKED_V6) blockList.addSubnet(addr, prefix, "ipv6")

/**
 * NAT64 / 6to4 / IPv4-mapped 这类「把 IPv4 藏在 IPv6 里」的地址，要拆出内嵌 IPv4 再判。
 *
 * 不处理的话 `::ffff:127.0.0.1`、`64:ff9b::7f00:1`（NAT64 的 127.0.0.1）、
 * `2002:7f00:1::`（6to4）都能绕过 `BlockList`（实测 `::ffff:127.0.0.1` 直接 check 为 false）。
 *
 * @returns 内嵌的 IPv4 字符串；不是这几类地址时返回 null
 */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase()

  /** 把 IPv6 展开成 8 组 16 位，返回 32 个十六进制字符（不做 :: 压缩以外的归一） */
  const expand = (addr: string): string | null => {
    // 混合写法 ::ffff:127.0.0.1 —— 先把末尾的 IPv4 换成两组十六进制
    let normalized = addr
    const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(normalized)
    if (dotted?.[1]) {
      const octets = dotted[1].split(".").map(Number)
      if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
      const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
      const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
      normalized = normalized.replace(dotted[1], `${hi}:${lo}`)
    }
    const [head, tail] = normalized.split("::")
    const headGroups = head ? head.split(":") : []
    const tailGroups = tail === undefined ? null : (tail ? tail.split(":") : [])
    const groups = tailGroups === null
      ? headGroups
      : [...headGroups, ...new Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    if (groups.length !== 8) return null
    return groups.map((g) => g.padStart(4, "0")).join("")
  }

  const hexToIpv4 = (hex: string): string | null => {
    if (hex.length !== 8) return null
    return [0, 2, 4, 6].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(".")
  }

  // NAT64 well-known prefix: 64:ff9b::/96 —— 内嵌 IPv4 在最后 32 位
  if (lower.startsWith("64:ff9b::")) {
    const full = expand(lower)
    return full ? hexToIpv4(full.slice(24)) : null
  }
  // 6to4: 2002::/16 —— 内嵌 IPv4 在第 3、4 组（即十六进制第 4~12 位）
  if (lower.startsWith("2002:")) {
    const full = expand(lower)
    return full ? hexToIpv4(full.slice(4, 12)) : null
  }
  // IPv4-mapped / IPv4-compatible: 前 80 位为 0 或 ::ffff
  if (lower.startsWith("::ffff:") || lower.startsWith("::")) {
    const full = expand(lower)
    if (!full) return null
    // ::ffff:a.b.c.d 与 ::a.b.c.d 的内嵌 IPv4 都在最后 32 位
    if (full.startsWith("00000000000000000000ffff") || full.startsWith("0".repeat(24))) {
      return hexToIpv4(full.slice(24))
    }
  }
  return null
}

/** 该 IP 是否属于禁止访问的地址（含内嵌 IPv4 的 IPv6 变体） */
export function isBlockedIp(ip: string, family?: number): boolean {
  if (ALLOW_PRIVATE) return false
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip
  const kind = net.isIP(bare)
  if (kind === 0) {
    // 不是 IP 字面量：调用方应当先解析。这里按「不安全」处理，避免静默放行。
    return true
  }

  const inner = embeddedIpv4(bare)
  if (inner) return isBlockedIp(inner, 4)

  if (kind === 4 || family === 4) return blockList.check(bare, "ipv4")
  return blockList.check(bare, "ipv6")
}

/** 域名/IP 是否允许作为抓取目标（解析不到也算不安全） */
export async function isBlockedHost(hostname: string): Promise<boolean> {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  if (net.isIP(host) !== 0) return isBlockedIp(host)

  try {
    const addresses = await dns.promises.lookup(host, { all: true })
    if (addresses.length === 0) return true
    // 任一解析结果落在禁区就拒绝：多 A 记录里混一个内网地址同样是绕过手法
    return addresses.some((a) => isBlockedIp(a.address, a.family))
  } catch {
    // 解析失败交给后续请求自己报错。这里不能因为"查不到"就放行，也不能把 DNS 抖动
    // 变成"源永久不可用" —— 返回 false 表示"地址本身没问题"，真正的失败在连接阶段暴露。
    return false
  }
}

/**
 * URL 层面的预校验（拦住「直接写 IP」和非法协议）。
 *
 * 这是 `lookup` 钩子的**补充**而非替代：`http://127.0.0.1/` 这种请求根本不会触发
 * `lookup`（Node 直接把 IP 拿去 connect），所以必须在发请求前单独挡一次。
 */
export async function assertFetchableUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`非法 URL: ${rawUrl}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 http/https: ${parsed.protocol}`)
  }
  // 可信端点（自建 RSSHub 的改写产物、以及它自己的重定向）放行
  if (isTrustedHost(parsed.hostname, parsed.port)) return
  if (await isBlockedHost(parsed.hostname)) {
    throw new Error(`拒绝访问内网/保留地址: ${parsed.hostname}`)
  }
}

/**
 * 给 Agent 装上 `lookup` 校验 —— 防 DNS rebinding 的核心那一步。
 *
 * 语义与 Miniflux 的 `Dialer.Control` 一致：**被检查的 IP 就是要连接的 IP**。
 */
function guardLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address as string, family)
    // 可信端点（自建 RSSHub）豁免：改写产物必须能连通
    if (isTrustedHost(hostname)) return callback(null, address, family)
    const list = Array.isArray(address)
      ? address.map((a) => a.address)
      : [address as string]
    for (const ip of list) {
      if (isBlockedIp(ip)) {
        return callback(
          Object.assign(new Error(`拒绝连接内网/保留地址: ${hostname} -> ${ip}`), { code: "ESSRFBLOCKED" }),
          address as string,
          family,
        )
      }
    }
    callback(null, address, family)
  })
}

/** 带 SSRF 校验的 http.Agent（覆盖 createConnection 注入上面的 lookup） */
export class GuardedHttpAgent extends http.Agent {
  createConnection(
    options: import("node:http").ClientRequestArgs,
    callback?: (err: Error | null, stream: import("node:stream").Duplex) => void,
  ): import("node:stream").Duplex | null | undefined {
    // 注入 lookup：Agent 建 socket 时走它，于是"检查的 IP"就是"连接的 IP"。
    // 签名沿用 Node 的 ClientRequestArgs（比 NetConnectOpts 宽，强转在内部完成）。
    return super.createConnection(
      { ...options, lookup: guardLookup } as import("node:http").ClientRequestArgs,
      callback,
    )
  }
}

/** 带 SSRF 校验的 https.Agent */
export class GuardedHttpsAgent extends https.Agent {
  createConnection(
    options: import("node:http").ClientRequestArgs,
    callback?: (err: Error | null, stream: import("node:stream").Duplex) => void,
  ): import("node:stream").Duplex | null | undefined {
    return super.createConnection(
      { ...options, lookup: guardLookup } as import("node:http").ClientRequestArgs,
      callback,
    )
  }
}

/** 直连时使用的受保护 agent（未配置代理时就是它们） */
export const guardedHttpAgent = new GuardedHttpAgent({ keepAlive: true })
export const guardedHttpsAgent = new GuardedHttpsAgent({ keepAlive: true })
