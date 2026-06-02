import { describe, expect, it } from "vitest"
import { app } from "../app"

describe("GET /api/health", () => {
  it("返回 { status: 'ok' }", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "ok" })
  })
})
