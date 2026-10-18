import { describe, expect, it } from "vitest"
import { isDeletedDocError } from "../couchdb/doc-errors"

describe("isDeletedDocError：只认墓碑，不认「从未存在」", () => {
  it("CouchDB 删除后的 404 带 reason=deleted", () => {
    // 实测 shape：{ statusCode: 404, error: "not_found", reason: "deleted", message: "deleted" }
    expect(isDeletedDocError({ statusCode: 404, error: "not_found", reason: "deleted", message: "deleted" })).toBe(true)
  })

  it("从未存在的文档（reason=missing）不能被当成墓碑", () => {
    expect(isDeletedDocError({ statusCode: 404, error: "not_found", reason: "missing" })).toBe(false)
  })

  it("网络错误 / 空值 / 非对象一律为 false", () => {
    expect(isDeletedDocError(new Error("ECONNREFUSED"))).toBe(false)
    expect(isDeletedDocError(undefined)).toBe(false)
    expect(isDeletedDocError(null)).toBe(false)
    expect(isDeletedDocError("deleted")).toBe(false)
  })
})
