# 把 RSSFed MCP 接入 DeepSeek Harness (dsh) — 技术方案

> 背景：`docs/ai-mcp-assistant.md` 里把 dsh 列为目标 MCP 客户端之一，但 dsh 平台
> **没有 `mcpServers` 这类原生 MCP 客户端配置入口**，无法像 Cursor/Claude Desktop 那样
> 直接填一个 URL 就接入。本文给出把 RSSFed 的 `/mcp` Streamable HTTP server
> **桥接为 dsh 原生 agent 工具** 的完整方案。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| dsh 能原生`mcpServers`配置吗？ | **不能**。dsh 基于 ACP + Cordis 插件系统，无 `mcpServers` 入口 |
| 能否让 agent 直接调用 RSSFed 的 MCP 工具？ | **能，通过写一个 dsh Cordis 插件**（桥接层），无需改 dsh 源码 |
| 调用形态 | 插件作为 **MCP 客户端**连 `/mcp`，把 15 个工具用 `defineTool()` 注册为 dsh 原生工具，agent 用起来和 `bash`/`ssh_list` 一样 |
| 需要什么前提 | ① 插件作为 MCP 客户端的 API token；② 安装插件并重载 web profile |
| 备选（零改动） | 用 `bash` + `curl` 以 MCP JSON-RPC 打 `/mcp`（不是原生工具，但最快可用） |

**先例（可完全照抄的官方插件模板）：**
- `@linxin666/dsh-ssh`：注册了 `ssh_list`/`ssh_exec` 等 6 个原生工具 + system-prompt 注入。
- `@linxin666/dsh-tool-describe-image`：单工具插件，最简模板。

两者均为「Hot-pluggable — mounted via cordis.patch.yml + profile node_modules symlink, no dsh source changes」。

---

## 2. dsh 插件机制（关键 API）

插件是一个 npm 包，导出 `name`/`inject`/`Config`(schemastery)/`apply`(用 `mountOnce` 包裹)，通过 `cordis.patch.yml` 的 `insert` 挂到 profile roster。

### 核心工具注册 API（来自 `@deepseek-ai/dsh-tools`）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'list_subscriptions',            // agent 调用名
  description: '…',                      // 给模型看的说明，写清楚触发场景
  parameters: {                          // 参数 schema（DSH 自有 DSL，非 zod）
    // 每个属性: { type, required?, description }
    // 支持 string/integer/number/boolean/array/object/oneOf/json
  },
  output: {
    schema: {                            // 返回值 JSON Schema（DSH 格式）
      type: 'object',
      additionalProperties: false,
      properties: { /* ... */ },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    // render 把 canonical value 转成给模型看的 ContentBlock
  },
  async execute(args, exec) { /* …返回符合 output.schema 的对象… */ },
}))
```

- `ctx.tools.register(tool)` 返回 disposer。
- `ctx.inject(['settings'], …)` 可加一个可编辑的配置区（存放 token、URL 等）。
- `ctx.systemPrompt.section({ name, order, text })` 向 agent 注入提示（声明插件存在、能力、限制），类似 `dsh-ssh` 的 `SSH_GUIDANCE` 中文说明。
- `ctx.webServer.register(route)` 可在 dsh 上挂 HTTP 路由（如 `/api/dsh-rssfed`，用于把 token 等从设置侧读取，避免 agent 直接拿 token）。

### 完整骨架（参照 `dsh-ssh/src/index.ts`）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'

export const name = 'rssfed'
export const inject = ['tools', 'webServer']   // 用到哪些服务

export interface Config { url?: string; token?: string; enabled?: boolean }
export const Config: z<Config> = z.object({
  url: z.string().default('http://localhost:3001/mcp'),
  token: z.string().default(''),
  enabled: z.boolean().default(true),
})

export const apply = mountOnce('@rssfed/dsh-mcp-bridge', applyImpl)
function applyImpl(ctx: Context, config: Config = {}) {
  // 读配置（含 settings 覆盖）
  // 连接 MCP server（见 §3）
  // 为每个 MCP 工具 defineTool + ctx.tools.register
  // 可选 ctx.systemPrompt.section 注入说明
}
```

---

## 3. 插件如何作为 MCP 客户端连 `/mcp`

RSSFed 的 `/mcp` 是 **Streamable HTTP** MCP server（`@modelcontextprotocol/server` + Hono）。插件在 host 进程里作为 MCP 客户端，走 **JSON-RPC + SSE**：

```
1. initialize                 → 协商协议版本、capabilities
2. notifications/initialized  → 通知握手完成（response 里给 Mcp-Session-Id）
3. tools/list                 → 拿到 15 个工具的 name/description/inputSchema
4. tools/call                 → 调具体工具，带 Authorization: Bearer <token>
```

实现方式两种：
- **A. 用官方客户端 SDK**：`@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`（dsh 的依赖树里已有该 SDK，可作为插件依赖安装）。优点：自动处理 SSE/session 管理。
- **B. 手写 fetch**：直接 POST JSON-RPC 到 `/mcp`，读 `text/event-stream`。优点：零额外依赖，控制力强。`mcp.ts` 已把 `/mcp`、`/mcp/` 都做成等价直达，无重定向问题。

> 建议 B（手写 fetch），因为 `mcp.ts` 认证是「每请求解析 Bearer → 注入 `x-rssfed-user-id` 内部头」，每次 `tools/call` 独立带 token 即可，无复杂状态。

---

## 4. 工具映射（15 个 → dsh 原生工具）

RSSFed `/mcp` 现有工具与参数（来自 `routes/mcp.ts`）：

| MCP 工具 | 参数 | 对应 dsh 工具名 |
|---|---|---|
| `list_subscriptions` | – | `rssfed_list_subscriptions` |
| `discover_feed` | url | `rssfed_discover_feed` |
| `add_subscription` | url, category? | `rssfed_add_subscription` |
| `remove_subscription` | feedId | `rssfed_remove_subscription` |
| `pause_subscription` | feedId | `rssfed_pause_subscription` |
| `resume_subscription` | feedId | `rssfed_resume_subscription` |
| `update_subscription` | feedId, title/url/…? | `rssfed_update_subscription` |
| `refetch_feed` | feedId | `rssfed_refetch_feed` |
| `list_bots` | – | `rssfed_list_bots` |
| `create_bot` | name, preferredUsername, desc?, avatar? | `rssfed_create_bot` |
| `update_bot` | botId, …? | `rssfed_update_bot` |
| `delete_bot` | botId | `rssfed_delete_bot` |
| `add_bot_feed` | botId, feedId | `rssfed_add_bot_feed` |
| `remove_bot_feed` | botId, feedId | `rssfed_remove_bot_feed` |
| `list_bot_feeds` | botId | `rssfed_list_bot_feeds` |
| `organize_bots` | – | `rssfed_organize_bots` |
| `get_feed` | feedId | `rssfed_get_feed` |
| `list_entries` | feedId, limit?, offset? | `rssfed_list_entries` |
| `search_entries` | feedId, keyword, limit? | `rssfed_search_entries` |

（`tools/list` 会返回准确的 schema，插件可**自动生成** dsh 参数 DSL，不必手写 19 份。）

**命名**：加 `rssfed_` 前缀避免与 dsh 内置工具（`bash`/`read` 等）冲突。也可不前缀，便于短调用。

---

## 5. 配置文件与认证

- 插件设置区（Settings → 插件配置）字段：`url`（默认 `http://localhost:3001/mcp`）、`token`（`rssfed_xxx`）。
- 认证：插件在每个 `tools/call` 请求头带 `Authorization: Bearer <token>`。
- **token 是硬性前提**：`routes/mcp.ts` 认证逻辑见 `services/api-token.ts`，token 明文只在创建时返回一次，DB 只存 SHA-256 hash，无法从库恢复。需用户提供现成 token 或登录后生成。

---

## 6. 安装与挂载步骤

1. 把插件包放到某个 repo（可在本 `rssfed` 工作区建 `packages/dsh-mcp-bridge`，或独立）。
2. `dsh plugin --profile web add <path-or-link>` （或手动在 `~/.dsh/profiles/web/node_modules` 建 symlink + 在 `cordis.patch.yml` 加 `insert`）。
3. 注入 cordis patch：
   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - insert:
       - id: rssfed
         name: '@rssfed/dsh-mcp-bridge'
   ```
4. 重载 web profile（重启 dsh web 服务 / 触发 HMR）。
5. 在 Settings 填 token/url。

> ⚠️ 影响：会重启你在用的 dsh Web GUI（`127.0.0.1:3080`）。插件改动属于「web shell/普通包」，需要按 dsh 约定重建 web 产物并刷新页面，**不是** client-plugin 那种免刷新的 HMR。

---

## 7. 风险与注意事项

1. **授权**：RSSFed 的 `/mcp` 已经按 token→userId 做了数据隔离（工具配置严格用户级，无 admin 操作），桥接层只要透传 token 即可，不引入额外授权面。
2. **token 安全**：token 存在 dsh 设置里，不要放进 model 可见的 system-prompt / 工具描述；工具 `execute` 内部从插件配置读取。
3. **agent 直接调用 vs HTTP 备选**：写插件前，可先用 `bash` + `curl` 验证 `/mcp` 可调通（已确认 401 = 服务正常，缺 token 而已），降低返工风险。
4. **PTC/native 呈现模式**：dsh 工具支持 `native`/`ptc`/`both` 三种呈现。桥接工具默认走 native 即可，模型直接点名调用。
5. **并发/超时**：工具 `execute` 要处理 `/mcp` 的 SSE 超时与错误，返回 `isError` 而非抛裸异常。

---

## 8. 里程碑

| 步骤 | 内容 | 状态 |
|---|---|---|
| M1 | 用 curl 验证 `/mcp` 握手 + 一个工具调用（需 token） | 待做 |
| M2 | 写 `packages/dsh-mcp-bridge` 插件（settings 配置 + MCP 客户端 fetch + 自动生成 tool） | 待做 |
| M3 | 安装挂载到 web profile + 验证工具出现在 agent 工具集 | 待做 |
| M4 | 实际让 agent 用 `rssfed_list_subscriptions` 等管理订阅 | 待做 |

---

## 9. 备选（零改动、立即可用）

若不写插件，可直接用 `bash` 以 MCP JSON-RPC 打 `/mcp`。示例：

```bash
# initialize
curl -s -N -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dsh","version":"1.0"}}}'
```

之后按 id 递增发 `tools/call`。缺点：不是原生工具，需要我每次手动构造请求，但**不装任何东西、不改环境**，适合先跑通验证。
