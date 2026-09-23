import { describe, it, expect } from 'vitest'
import { detectLangFromClass, highlightCodeBlocks } from '../../composables/useCodeHighlight'

describe('detectLangFromClass', () => {
  it('识别 language- 前缀', () => {
    expect(detectLangFromClass('language-ts')).toBe('typescript')
    expect(detectLangFromClass('language-python')).toBe('python')
  })

  it('识别 lang- 前缀与多个 class', () => {
    expect(detectLangFromClass('highlight lang-rust')).toBe('rust')
  })

  it('把常见别名归一成 shiki 语言名', () => {
    expect(detectLangFromClass('language-js')).toBe('javascript')
    expect(detectLangFromClass('language-bash')).toBe('shellscript')
    expect(detectLangFromClass('language-yml')).toBe('yaml')
    expect(detectLangFromClass('language-c++')).toBe('cpp')
  })

  it('不支持的语言返回 null（保持原样而不是报错）', () => {
    expect(detectLangFromClass('language-brainfuck')).toBeNull()
  })

  it('没有语言 class 时返回 null', () => {
    expect(detectLangFromClass('')).toBeNull()
    expect(detectLangFromClass('highlight source-code')).toBeNull()
  })
})

describe('highlightCodeBlocks', () => {
  it('把 language-xxx 的代码块替换成 shiki 结构', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre><code class="language-js">const a = 1</code></pre>'

    await highlightCodeBlocks(root)

    const shikiPre = root.querySelector('pre.shiki')
    expect(shikiPre).toBeTruthy()
    // 亮色内联 + 暗色变量都在，暗色覆盖交给 main.css
    expect(shikiPre?.getAttribute('style')).toContain('--shiki-dark')
  })

  it('没有可识别语言时不改动 DOM', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre><code>纯文本</code></pre>'
    const before = root.innerHTML

    await highlightCodeBlocks(root)

    expect(root.innerHTML).toBe(before)
  })

  it('isStale 为真时中途放弃', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre><code class="language-js">let x = 1</code></pre>'

    await highlightCodeBlocks(root, () => true)

    expect(root.querySelector('pre.shiki')).toBeNull()
  })
})
