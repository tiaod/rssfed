import { Hono } from "hono"
import type { Context, Next } from "hono"
import { auth } from "../auth"
import { getCompressedImage, IMAGE_PARAM_LIMITS } from "../images/cache"

/** 中间件写入的请求级变量 */
type Variables = { userId: string }

/** 本路由的挂载点（app.ts 用同一常量注册） */
export const IMAGES_ROUTE_PREFIX = "/api/images"

export const imagesRouter = new Hono<{ Variables: Variables }>()

/**
 * 按需图片压缩接口：输入远程图片 URL（+可选压缩参数），返回 AVIF。
 *
 *   GET /api/images/cached?url=<远程图片>&w=<最大宽度>&q=<质量>
 *
 * 谁在用它：
 *   1. **服务端聚合**（feed 库与用户 timeline 库的附件）走同一份内容寻址缓存
 *      （见 images/cache.ts），所以这个接口的命中率与内部路径完全一致；
 *   2. 浏览器：附件预算外的条目（更老的条目没有本地附件）可以让 `<img>` 指向这里，
 *      拿到的是压缩后的 AVIF 而不是原始大图 —— 比直连原图省流量，也避开了原站的防盗链。
 *
 * 为什么要求登录：这是个「服务端替我请求任意 URL」的能力。虽然正文图本来就可能来自内网
 * 自建图床（那条路径不加限制，见 isPrivateHost 的说明），但对外接口不能让未登录者当开放代理用。
 * 内网/链路本地地址默认拒绝（IMAGE_CACHE_ALLOW_PRIVATE_HOSTS=true 可放开）。
 */
imagesRouter.use("/*", async (c: Context<{ Variables: Variables }>, next: Next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) return c.json({ error: "unauthorized" }, 401)
  c.set("userId", session.user.id)
  await next()
})

imagesRouter.get("/cached", async (c) => {
  const url = c.req.query("url")
  if (!url) return c.json({ error: "missing_url" }, 400)

  const width = parseIntParam(c.req.query("w"), IMAGE_PARAM_LIMITS.minWidth, IMAGE_PARAM_LIMITS.maxWidth)
  if (width === "invalid") {
    return c.json({ error: "invalid_w", hint: `w 需在 ${IMAGE_PARAM_LIMITS.minWidth}..${IMAGE_PARAM_LIMITS.maxWidth} 之间` }, 400)
  }
  const quality = parseIntParam(c.req.query("q"), IMAGE_PARAM_LIMITS.minQuality, IMAGE_PARAM_LIMITS.maxQuality)
  if (quality === "invalid") {
    return c.json({ error: "invalid_q", hint: `q 需在 ${IMAGE_PARAM_LIMITS.minQuality}..${IMAGE_PARAM_LIMITS.maxQuality} 之间` }, 400)
  }

  const result = await getCompressedImage(
    {
      url,
      ...(width !== undefined ? { maxWidth: width } : {}),
      ...(quality !== undefined ? { quality } : {}),
    },
    { allowPrivateHosts: allowPrivateHosts() },
  )
  if (!result.ok) {
    // 502 而不是 404：失败原因是「上游图取不到/解不开」，不是这个接口本身没有资源
    return c.json({ error: "image_unavailable", reason: result.reason }, 502)
  }

  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      // 内容寻址（key = url + 参数 的哈希）：同一 URL 的字节永不变，可以放心长缓存
      "Cache-Control": "public, max-age=31536000, immutable",
      // 便于排查「这张图是压出来的还是命中缓存拿的」
      "X-Image-Cache": result.hit ? "hit" : "miss",
    },
  })
})

/** 内网地址是否放行（默认不放行；自建图床在内网时需要显式打开） */
function allowPrivateHosts(): boolean {
  return (process.env.IMAGE_CACHE_ALLOW_PRIVATE_HOSTS ?? "").trim().toLowerCase() === "true"
}

/**
 * 解析可选的整数 query 参数。
 * 未提供返回 undefined（走全局默认），非法/越界返回 "invalid"（调用方 400，不静默改用默认值：
 * 静默忽略会让前端以为参数生效了，排查时看不到任何信号）。
 */
function parseIntParam(raw: string | undefined, min: number, max: number): number | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined
  if (!/^\d+$/.test(raw)) return "invalid"
  const value = Number(raw)
  return value >= min && value <= max ? value : "invalid"
}
