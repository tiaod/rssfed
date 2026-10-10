import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNdjsonParser,
  importOpmlStreaming,
  type OpmlImportEvent
} from '~/utils/opmlImport'

/**
 * OPML 导入的流式客户端。
 *
 * 后端逐源推 NDJSON 进度事件（每个源都要联网解析一次，几十上百个源要跑几分钟），
 * 这里钉住解析器的分块边界处理（chunk 边界与行边界无关）与各类失败的呈现，
 * 因为「进度条卡住/错报」几乎都出在这两处。
 */

/** 用给定的分块字符串造一个流式响应 */
function streamResponse(chunks: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' }, ...init }
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createNdjsonParser', () => {
  it('一行被切成两半时能拼回来', () => {
    const events: unknown[] = []
    const parser = createNdjsonParser<unknown>(e => events.push(e))

    parser.push(new TextEncoder().encode('{"type":"sta'))
    parser.push(new TextEncoder().encode('rt","total":3}\n'))
    parser.flush()

    expect(events).toEqual([{ type: 'start', total: 3 }])
  })

  it('一个 chunk 里有多行时逐行触发，空行忽略', () => {
    const events: unknown[] = []
    const parser = createNdjsonParser<unknown>(e => events.push(e))

    parser.push(new TextEncoder().encode('{"type":"start","total":2}\n\n{"type":"done"}\n'))
    parser.flush()

    expect(events).toEqual([{ type: 'start', total: 2 }, { type: 'done' }])
  })

  it('结束时最后一行没有换行也能解析（flush）', () => {
    const events: unknown[] = []
    const parser = createNdjsonParser<unknown>(e => events.push(e))

    parser.push(new TextEncoder().encode('{"type":"done","imported":1}'))
    expect(events).toEqual([])

    parser.flush()
    expect(events).toEqual([{ type: 'done', imported: 1 }])
  })
})

describe('importOpmlStreaming', () => {
  it('按到达顺序回调事件，并返回最终汇总', async () => {
    const fetchMock = vi.fn(async () => streamResponse([
      '{"type":"start","total":2}\n{"type":"progress","done":1,"total":2,"imported":1,"skipped":0,"failed":0,"title":"A"}\n',
      '{"type":"progress","done":2,"total":2,"imported":1,"skipped":1,"failed":0,"title":"B"}\n',
      '{"type":"done","total":2,"imported":1,"skipped":1,"failed":[]}\n'
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const events: OpmlImportEvent[] = []
    const result = await importOpmlStreaming('http://localhost:3001/api/feeds/import-opml', '<opml/>', {
      onEvent: e => events.push(e)
    })

    expect(events.map(e => e.type)).toEqual(['start', 'progress', 'progress', 'done'])
    expect(result).toEqual({ total: 2, imported: 1, skipped: 1, failed: [] })

    // 跨源访问必须带上会话 cookie
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:3001/api/feeds/import-opml')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ opml: '<opml/>' })
  })

  it('开流前的 JSON 错误（未登录 / OPML 非法）按原样抛出，带 data.error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'OPML 中未发现任何订阅源' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    )))

    const failure = await importOpmlStreaming('http://x/api/feeds/import-opml', '<opml/>')
      .catch((e: unknown) => e as Error & { data?: { error?: string } })

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('OPML 中未发现任何订阅源')
    expect((failure as { data?: { error?: string } }).data?.error).toBe('OPML 中未发现任何订阅源')
  })

  it('非 JSON 的错误响应也不会吞掉，退化成带状态码的提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })))

    await expect(importOpmlStreaming('http://x/api/feeds/import-opml', '<opml/>'))
      .rejects.toThrow('导入失败（HTTP 504）')
  })

  it('流中途的 error 事件抛成错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      '{"type":"start","total":3}\n',
      '{"type":"progress","done":1,"total":3,"imported":1,"skipped":0,"failed":0,"title":"A"}\n',
      '{"type":"error","message":"CouchDB 炸了"}\n'
    ])))

    await expect(importOpmlStreaming('http://x/api/feeds/import-opml', '<opml/>'))
      .rejects.toThrow('CouchDB 炸了')
  })

  it('流结束却没有 done 事件时视为中断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['{"type":"start","total":3}\n'])))

    await expect(importOpmlStreaming('http://x/api/feeds/import-opml', '<opml/>'))
      .rejects.toThrow('导入中断：未收到完整结果')
  })

  it('abort 后以 AbortError 拒绝（用户取消导入不该显示成失败）', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        reject(error)
      })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = importOpmlStreaming('http://x/api/feeds/import-opml', '<opml/>', { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal)
  })
})
