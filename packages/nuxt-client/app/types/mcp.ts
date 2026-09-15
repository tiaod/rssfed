/**
 * MCP（Model Context Protocol）助手相关类型。
 *
 * 用于「AI 助手接入」页面：管理用户个人 API token（供 MCP 客户端以
 * `Authorization: Bearer <token>` 调用 `/mcp` 端点），并展示各客户端接入配置。
 */

/** 一个用户 API token 的元数据（不含明文，与后端 `GET /api/user/tokens` 返回一致） */
export interface McpToken {
  id: string
  name: string
  /** 明文前缀（前 12 位 + …），用于用户识别，非完整 token */
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

/** 生成 token 时的响应：明文 token 仅此一次返回，之后不可再取 */
export interface McpTokenCreated {
  id: string
  name: string
  /** 明文 token（仅创建时返回一次，请提示用户妥善保存） */
  token: string
  /** 明文前缀（前 12 位 + …） */
  prefix: string
  expiresAt: string | null
  createdAt: string
}

/** 前端「AI 助手接入」页用到的 MCP 端点信息（由运行时配置推导） */
export interface McpEndpointInfo {
  /** MCP 端点完整地址，如 http://localhost:3001/mcp */
  url: string
}
