/**
 * 动态 `/favicon.ico`。
 *
 * 这个路径必须是根路径：浏览器在页面没有声明 icon 时会固定探测它，第三方服务也
 * 常常直接抓它。内容按站点配置（上传的方形图标 → 站点 Logo 裁剪 → 内置图形）实时
 * 生成，与管理端保存后的 manifest / PWA 图标保持同一来源。
 *
 * URL 固定无法用 `?v=` 做缓存区分，故用 `no-cache` + ETag：浏览器每次带
 * If-None-Match 回来验证，配置改完立即生效；未变化时只回 304，不重传图标。
 */

import { Hono } from "hono"
import { etagMatches } from "../pwa/etag"
import { getFaviconIco } from "../pwa/favicon"
import { settingsVersion } from "../pwa/manifest"
import { loadPwaRow } from "./site-settings"

export const faviconRouter = new Hono()

faviconRouter.get("/favicon.ico", async (c) => {
  const row = await loadPwaRow()
  const etag = `W/"${settingsVersion(row)}-favicon"`

  // 304 也要回带 ETag：客户端据此续上缓存条目，否则下次又变成无条件请求
  if (etagMatches(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { "Cache-Control": "no-cache", "ETag": etag })
  }

  const ico = await getFaviconIco(row)

  return c.body(new Uint8Array(ico), 200, {
    "Content-Type": "image/x-icon",
    "Cache-Control": "no-cache",
    "ETag": etag
  })
})
