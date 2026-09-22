/**
 * 把 ofetch / Hono 抛出的错误整理成可展示的文案。
 *
 * 优先级：后端返回的 `error.data.error`（ofetch 把响应体挂在 data 上）→
 * `error.message`（网络层/未预期的错误）→ 兜底文案。
 * 参数类型是 unknown：调用方在 catch 里拿到的东西本来就无法保证形状。
 */
export function errorMessage(e: unknown, fallback = '未知错误'): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as { data?: { error?: unknown }, message?: unknown }
    if (typeof err.data?.error === 'string' && err.data.error) return err.data.error
    if (typeof err.message === 'string' && err.message) return err.message
  }
  if (typeof e === 'string' && e) return e
  return fallback
}
