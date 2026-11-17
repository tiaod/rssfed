/**
 * 订阅源可编辑字段的 URL 校验（管理端 `PUT /api/feeds/:feedId`）。
 *
 * ## 为什么四个字段不能一视同仁
 *
 * | 字段 | 谁来消费 | 该查什么 |
 * | --- | --- | --- |
 * | `url` | 服务端抓取（`fetchFeed`） | 必须是 http(s)，且不能指向内网 —— 否则这条字段就是一个 SSRF 入口 |
 * | `image`（图标） | **服务端下载**（`cacheSingleImage`） | 同上：它会被 worker 真的去取 |
 * | `siteUrl` | 前端 `<a href>` / 「访问网站」 | 只做展示跳转，不服务端取数；但 `javascript:` 这类协议会被点开，必须限 http(s) |
 * | `description` / `title` | 纯文本展示 | 不是 URL，不在这里校验 |
 *
 * 所以对 `url` / `image` 额外做内网拦截（`ssrf-guard`），对 `siteUrl` 只做协议白名单 ——
 * 把 `siteUrl` 也拿内网规则拦一遍是错的：`siteUrl` 指向 `localhost:8099` 只是"站点地址写在
 * 本机"，服务端不会去访问它（实测库里就有这种历史数据）。
 *
 * ## 与「归一化」的取舍
 *
 * 这里**不改写**用户输入（不把 `rsshub:1200` 改写成 `rsshub.app`）。归一化属于行为变更：
 * 会改变已存数据的语义，还要处理存量迁移，且 `rsshub:1200` 在容器内部署下是合法地址。
 * 校验只负责"存进去的值是能用的"，不替用户猜他想要哪个地址。
 *
 * ## 空串
 *
 * 空串是合法输入，含义是"清空该字段"（前端编辑弹窗清空输入框就是这个语义）。
 * 库里的 `image` 有历史空串值，不能当成非法数据拒绝。
 */

/** 允许的协议：必须显式给出，且只能是 http/https */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"])

export interface FeedFieldValidationError {
  /** 出错的字段名（与请求体字段一致） */
  field: "url" | "image" | "siteUrl"
  /** 面向用户的说明 */
  message: string
}

/**
 * 校验单个 URL 字段。
 *
 * @param field 字段名（决定是否追加内网检查与提示措辞）
 * @param value 原始输入（空串表示清空，直接放行）
 * @param checkPrivate 是否拦截内网地址（`url` / `image` 为 true）
 */
export async function validateFeedUrlField(
  field: "url" | "image" | "siteUrl",
  value: string,
  checkPrivate: boolean,
): Promise<FeedFieldValidationError | null> {
  const trimmed = value.trim()
  if (trimmed === "") return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { field, message: `${labelOf(field)} 不是合法的网址：${trimmed}` }
  }

  // 只认 http/https：挡住 javascript: / data: / file: 这类会被浏览器或服务端当成别的东西处理的协议。
  // siteUrl 尤其重要 —— 它在前端是 <a href>，javascript: 点一下就是 XSS。
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { field, message: `${labelOf(field)} 只支持 http/https（当前是 ${parsed.protocol || "空协议"}）` }
  }

  if (checkPrivate) {
    // 与服务端抓取共用同一套判定（见 rss/ssrf-guard.ts）：
    // 这条字段服务端真的会去请求，存进内网地址等于给自己留一个 SSRF 入口。
    const { isBlockedHost } = await import("../rss/ssrf-guard")
    if (await isBlockedHost(parsed.hostname)) {
      return { field, message: `${labelOf(field)} 指向内网/保留地址，服务端不会去访问：${parsed.hostname}` }
    }
  }

  return null
}

function labelOf(field: "url" | "image" | "siteUrl"): string {
  switch (field) {
    case "url": return "Feed URL"
    case "image": return "图标 URL"
    case "siteUrl": return "站点链接"
  }
}

/**
 * 校验一次 PUT 里所有 URL 相关字段，返回第一个错误（多个错误对管理员没有额外价值）。
 *
 * `url` 与 `image` 走内网检查，`siteUrl` 只查协议 —— 理由见文件头。
 */
export async function validateFeedPatch(body: Record<string, unknown>): Promise<FeedFieldValidationError | null> {
  const rules: Array<{ field: "url" | "image" | "siteUrl", checkPrivate: boolean }> = [
    { field: "url", checkPrivate: true },
    { field: "image", checkPrivate: true },
    { field: "siteUrl", checkPrivate: false },
  ]
  for (const { field, checkPrivate } of rules) {
    const value = body[field]
    if (typeof value !== "string") continue
    const error = await validateFeedUrlField(field, value, checkPrivate)
    if (error) return error
  }
  return null
}
