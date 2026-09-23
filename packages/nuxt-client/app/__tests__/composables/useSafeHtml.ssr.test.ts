// @vitest-environment node
// 架构契约：**正文不参与 SSR**。
//
// 服务端没有 DOM，DOMPurify 在 Node 下默认导出是工厂函数，调用 sanitize 会抛
// TypeError。所以 EntryDetail 用 ClientOnly 包住正文，SSR 阶段根本不输出它，
// 这里锁住「服务端安全降级为空串」这一行为。
//
// 如果哪天要给正文加 SSR（例如条目详情页），就必须同时补上服务端净化 ——
// 否则浏览器解析 SSR 响应时会先于任何客户端代码执行其中的脚本。
// 这个用例失败就是在提醒你：契约变了，得重新设计那条链。
import { describe, it, expect } from 'vitest'
import { sanitizeEntryHtml } from '../../composables/useSafeHtml'

describe('sanitizeEntryHtml（服务端 / 无 window 环境）', () => {
  it('没有 window 时安全降级为空串，而不是抛错', () => {
    expect(typeof window).toBe('undefined')

    expect(sanitizeEntryHtml('<p>服务端正文</p><script>alert(1)</script>')).toBe('')
  })

  it('空输入同样返回空串', () => {
    expect(sanitizeEntryHtml(undefined)).toBe('')
    expect(sanitizeEntryHtml('')).toBe('')
  })
})
