/**
 * OPML 导入的流式客户端。
 *
 * 后端 `POST /api/feeds/import-opml` 返回的是一串 NDJSON 进度事件而不是单个 JSON
 * （导入要给每个订阅源联网解析一次，几十上百个源要跑几分钟）。这里不用 `$fetch`：
 * 它会把响应体缓冲到流结束才 resolve，那就又回到「转圈圈、没进度」的老样子。
 */

/** 服务端进度事件（与 hono-server 的 ImportOpmlEvent 一一对应） */
export type OpmlImportEvent
  = | { type: 'start', total: number }
    | { type: 'progress', done: number, total: number, imported: number, skipped: number, failed: number, title: string }
    | { type: 'done', total: number, imported: number, skipped: number, failed: OpmlImportFailed[] }
    | { type: 'error', message: string }

export interface OpmlImportFailed {
  url: string
  error: string
}

export interface OpmlImportResult {
  total: number
  imported: number
  skipped: number
  failed: OpmlImportFailed[]
}

/** 调用方正在展示的实时进度（由 start/progress 事件累积而来） */
export interface OpmlImportProgress {
  done: number
  total: number
  imported: number
  skipped: number
  failed: number
  /** 刚处理完的订阅源标题，用于让用户看到"确实在动" */
  title: string
}

/** 导入失败：`data.error` 与 $fetch 的错误形状保持一致，调用方可以照旧读它 */
function importError(message: string, serverError?: string) {
  const error = new Error(message) as Error & { data?: { error: string } }
  if (serverError) error.data = { error: serverError }
  return error
}

/**
 * 把 fetch 的分块切成一行行 JSON。
 *
 * chunk 边界与行边界无关（一行可能被切成两半，也可能一次到达好几行），所以必须自己缓冲残行。
 * 空行忽略；整行解析失败说明对端不是本接口的格式（例如反代塞了别的内容），直接抛错暴露出来。
 * 结束前若还有不带换行的残行，由 flush() 补一次。
 */
export function createNdjsonParser<T>(onEvent: (event: T) => void) {
  const decoder = new TextDecoder()
  let buffer = ''
  const parseLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    onEvent(JSON.parse(trimmed) as T)
  }
  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        parseLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    flush() {
      buffer += decoder.decode()
      parseLine(buffer)
      buffer = ''
    }
  }
}

/**
 * 消费导入进度流，返回最终汇总。
 *
 * @param url 完整的 import-opml 地址
 * @param options.onEvent 每个进度事件回调一次（渲染进度条用）
 * @param options.signal 中止信号：用户取消导入时断开连接，服务端会停止处理剩余的源
 */
export async function importOpmlStreaming(
  url: string,
  opml: string,
  options: { onEvent?: (event: OpmlImportEvent) => void, signal?: AbortSignal } = {}
): Promise<OpmlImportResult> {
  const response = await fetch(url, {
    method: 'POST',
    // 后端与前端可能不同源（开发态 :3000 → :3001），会话 cookie 必须显式带上
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opml }),
    signal: options.signal
  })

  if (!response.ok) {
    // 开流前的失败（未登录 / OPML 非法 / 没有订阅源）仍是普通 JSON 响应
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw importError(payload?.error ?? `导入失败（HTTP ${response.status}）`, payload?.error)
  }
  if (!response.body) {
    throw importError('当前浏览器不支持流式响应，无法显示导入进度')
  }

  let result: OpmlImportResult | null = null
  let streamError: string | null = null

  const parser = createNdjsonParser<OpmlImportEvent>((event) => {
    options.onEvent?.(event)
    if (event.type === 'done') {
      result = { total: event.total, imported: event.imported, skipped: event.skipped, failed: event.failed }
    } else if (event.type === 'error') {
      streamError = event.message
    }
  })

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parser.push(value)
    }
    parser.flush()
  } finally {
    reader.releaseLock()
  }

  // 流中途失败时没有 done 事件，只有 error；正常结束则必须有 done
  if (streamError) throw importError(streamError, streamError)
  if (!result) throw importError('导入中断：未收到完整结果')
  return result
}
