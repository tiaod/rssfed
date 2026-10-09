import { describe, expect, it } from "vitest"
import { TIMELINE_VALIDATE_DOC_UPDATE } from "../couchdb/client"

/**
 * 单库方案的写方向闸门：`entry` / `feed` 只能由服务端（admin 连接）写，
 * 浏览器经代理转发时带的是 `roles: ["user"]`（见 routes/couchdb.ts 的 Proxy Authentication），
 * 必须被拦下 —— 否则客户端一次误写就能影子化某个条目（同名 `entry:` 文档让聚合侧的
 * fetchExistingIds 以为它已存在而跳过聚合），或者删掉服务端刚聚合出来的内容。
 *
 * 这里把设计文档里的函数源码取出来**真的执行**：它是 JavaScript 字符串，
 * 只有跑一遍才能确认 CouchDB 与我们的语义理解一致（throw 对象形状、_deleted 分支等）。
 */
const validate = new Function(`return (${TIMELINE_VALIDATE_DOC_UPDATE})`)() as (
  newDoc: Record<string, unknown>,
  oldDoc: Record<string, unknown> | null,
  userCtx: { name?: string | null, roles: string[] },
) => void

const ADMIN = { name: null as string | null, roles: ["_admin"] }
const USER = { name: "u1", roles: ["user"] }

/** 执行校验并返回「被拒绝时的 forbidden 文案」，通过时返回 null */
function reject(newDoc: Record<string, unknown>, oldDoc: Record<string, unknown> | null, userCtx: typeof ADMIN): string | null {
  try {
    validate(newDoc, oldDoc, userCtx)
    return null
  } catch (err) {
    const e = err as { forbidden?: string, message?: string }
    return e.forbidden ?? e.message ?? "unknown"
  }
}

describe("validate_doc_update：服务端独占 entry / feed", () => {
  it("服务端（admin）写条目、写 feed 元数据都放行", () => {
    expect(reject({ _id: "entry:abc:1", type: "entry" }, null, ADMIN)).toBeNull()
    expect(reject({ _id: "feed:abc", type: "feed" }, null, ADMIN)).toBeNull()
    // 删除也一样放行（缩窗 / 退订清理）
    expect(reject({ _id: "entry:abc:1", _rev: "1-x", _deleted: true }, { type: "entry" }, ADMIN)).toBeNull()
  })

  it("浏览器写条目被拒（影子化 / 伪造条目）", () => {
    expect(reject({ _id: "entry:abc:1", type: "entry" }, null, USER)).toMatch(/entry\/feed/)
    expect(reject({ _id: "feed:abc", type: "feed" }, null, USER)).toMatch(/entry\/feed/)
  })

  it("浏览器删服务端聚合出来的条目被拒（否则本地删除会推上来）", () => {
    // 删除时 newDoc 只有 _id/_rev/_deleted，没有 type —— 必须靠 oldDoc 判断
    expect(reject({ _id: "entry:abc:1", _rev: "1-x", _deleted: true }, { type: "entry" }, USER)).toMatch(/entry\/feed/)
    expect(reject({ _id: "feed:abc", _rev: "1-x", _deleted: true }, { type: "feed" }, USER)).toMatch(/entry\/feed/)
  })

  it("浏览器写/删自己的状态文档放行（订阅、已读收藏、分组偏好）", () => {
    expect(reject({ _id: "subscription:f1", type: "subscription" }, null, USER)).toBeNull()
    expect(reject({ _id: "entry-state:e1", type: "entry-state" }, null, USER)).toBeNull()
    expect(reject({ _id: "group-pref:g1", type: "group-pref" }, null, USER)).toBeNull()
    expect(reject({ _id: "subscription:f1", _rev: "1-x", _deleted: true }, { type: "subscription" }, USER)).toBeNull()
  })

  it("没有 type 的删除（例如清理一个未知的旧文档）不误伤", () => {
    // 只按 oldDoc 判断：旧文档本身就不是服务端独占类型，允许删
    expect(reject({ _id: "legacy:1", _rev: "1-x", _deleted: true }, { type: "group-pref" }, USER)).toBeNull()
    expect(reject({ _id: "legacy:1", _rev: "1-x", _deleted: true }, null, USER)).toBeNull()
  })

  it("roles 为空的已认证用户同样被拦（只有 _admin 才是服务端身份）", () => {
    // 代理转发一定带 roles=user；这里锁死「没有 _admin 就不放行」的语义，
    // 避免将来有人把判断写成「roles 里没有 user 就放行」这类反向逻辑
    expect(reject({ _id: "entry:x", type: "entry" }, null, { name: "u1", roles: [] })).toMatch(/entry\/feed/)
    expect(reject({ _id: "subscription:f1", type: "subscription" }, null, { name: "u1", roles: [] })).toBeNull()
  })
})
