// @vitest-environment jsdom
// 用到 DOMPurify（与 happy-dom 不兼容，见 useSafeHtml.test.ts 的说明）与 CSSOM 的
// aspect-ratio / min() 解析 —— jsdom 与浏览器一致，happy-dom 不保证
import { describe, it, expect } from 'vitest'
import { applyResponsiveIframeSizing, isVideoEmbed } from '../../utils/iframeSizing'
import { sanitizeEntryHtml } from '../../composables/useSafeHtml'

/** 造一个与净化输出同形的 iframe（属性 + 内联样式） */
function makeIframe(attrs: Record<string, string> = {}, style = ''): HTMLIFrameElement {
  const el = document.createElement('iframe')
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
  if (style) el.setAttribute('style', style)
  return el
}

/** 从净化结果里取回 iframe（字符串断言会被 data-* 之类干扰） */
function parseIframe(html: string): HTMLIFrameElement | null {
  return new DOMParser().parseFromString(html, 'text/html').querySelector('iframe')
}

describe('isVideoEmbed', () => {
  it('allowfullscreen 就算播放器（播放器最普遍的特征）', () => {
    expect(isVideoEmbed(makeIframe({ src: 'https://a.example/x', allowfullscreen: '' }))).toBe(true)
  })

  it('allow 里带 fullscreen 也算', () => {
    expect(isVideoEmbed(makeIframe({
      src: 'https://a.example/x',
      allow: 'autoplay; fullscreen; picture-in-picture'
    }))).toBe(true)
  })

  it('class / title 里写明 video 或 player 的算', () => {
    expect(isVideoEmbed(makeIframe({ src: 'https://a.example/x', class: 'ithome_video bilibili' }))).toBe(true)
    expect(isVideoEmbed(makeIframe({ src: 'https://a.example/x', class: 'wp-block-embed-youtube' }))).toBe(true)
    expect(isVideoEmbed(makeIframe({ src: 'https://a.example/x', title: 'Embedded video player' }))).toBe(true)
  })

  it('地址路径是播放器页的算', () => {
    expect(isVideoEmbed(makeIframe({ src: 'https://player.bilibili.com/player.html?bvid=BV1' }))).toBe(true)
    expect(isVideoEmbed(makeIframe({ src: 'https://www.youtube.com/embed/abc' }))).toBe(true)
    expect(isVideoEmbed(makeIframe({ src: 'https://example.com/video/123.html' }))).toBe(true)
  })

  it('否定式：普通内嵌页（投票 / 地图 / 评论区）不算播放器', () => {
    expect(isVideoEmbed(makeIframe({ src: 'https://example.com/poll/3' }))).toBe(false)
    expect(isVideoEmbed(makeIframe({ src: 'https://example.com/widget?video=1' }))).toBe(false)
    // 查询串里的 video 不能当判据：普通页面的追踪参数里到处都是
    expect(isVideoEmbed(makeIframe({ src: 'https://example.com/post?utm_source=video' }))).toBe(false)
  })

  it('地址解析不了的（相对地址 / 空）不算播放器', () => {
    expect(isVideoEmbed(makeIframe({ src: '/player.html' }))).toBe(false)
    expect(isVideoEmbed(makeIframe({}))).toBe(false)
  })
})

describe('applyResponsiveIframeSizing', () => {
  it('宽高都声明了：按声明的比例缩放（非视频嵌入），宽度取「声明值与容器的较小者」', () => {
    const el = makeIframe({ src: 'https://example.com/poll/3', width: '800', height: '500' })
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('800 / 500')
    expect(el.style.width).toBe('min(800px, 100%)')
    expect(el.style.maxWidth).toBe('100%')
    // auto 高度 + 比例：宽度缩到容器宽时高度等比缩小，不会被拍扁成 150px 横条
    expect(el.style.height).toBe('auto')
    expect(el.style.boxSizing).toBe('border-box')
  })

  it('横向视频嵌入铺满容器：源站写死的 640×360 是它自己窄栏的尺寸，不该照抄', () => {
    const el = makeIframe({ src: 'https://player.bilibili.com/player.html?bvid=BV1', width: '640', height: '360' })
    applyResponsiveIframeSizing(el)

    expect(el.style.width).toBe('100%')
    expect(el.style.aspectRatio).toBe('640 / 360')
    expect(el.style.height).toBe('auto')
  })

  it('竖版视频不铺满：拉成 100% 宽会变成一屏高的竖条', () => {
    const el = makeIframe({ src: 'https://space.bilibili.com/video/vertical', width: '330', height: '450' })
    applyResponsiveIframeSizing(el)

    expect(el.style.width).toBe('min(330px, 100%)')
    expect(el.style.aspectRatio).toBe('330 / 450')
  })

  it('定高嵌入（width="100%" height="152" 的音频条）保持源站高度，不按 16:9 撑开', () => {
    // Spotify / SoundCloud 都这么写；按视频处理会变成 621px 高的空条
    for (const src of ['https://open.spotify.com/embed/track/x', 'https://w.soundcloud.com/player/?url=x']) {
      const el = makeIframe({ src, width: '100%', height: '152' })
      applyResponsiveIframeSizing(el)

      expect(el.style.width).toBe('')
      expect(el.style.height).toBe('')
      expect(el.style.aspectRatio).toBe('')
      expect(el.style.maxWidth).toBe('100%')
    }
  })

  it('尺寸写成内联样式（style="width:800px;height:450px"）时同样换算', () => {
    const el = makeIframe({ src: 'https://example.com/poll/3' }, 'width:800px;height:450px')
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('800 / 450')
    expect(el.style.width).toBe('min(800px, 100%)')
  })

  it('尺寸带 px 后缀或大写也能读', () => {
    const el = makeIframe({ width: '560px', height: '315PX' })
    applyResponsiveIframeSizing(el)

    expect(el.style.aspectRatio).toBe('560 / 315')
  })

  it('否定式：写 !important，压过源站同样带 !important 的内联尺寸', () => {
    const el = makeIframe({}, 'width:800px !important;height:450px !important')
    applyResponsiveIframeSizing(el)

    expect(el.style.getPropertyPriority('width')).toBe('important')
    expect(el.style.getPropertyPriority('height')).toBe('important')
    expect(el.style.getPropertyPriority('aspect-ratio')).toBe('important')
  })

  it('只声明高度时保留高度：音频播放器 / 竖版视频不能被拉成 16:9', () => {
    // 用内联样式表达高度：jsdom 不把 iframe 的 height 属性反射进 style，浏览器里两者等价
    const el = makeIframe({}, 'height: 600px')
    applyResponsiveIframeSizing(el)

    expect(el.style.width).toBe('')
    expect(el.style.aspectRatio).toBe('')
    // 高度原样留着（不能被改成 auto，否则音频播放器会塌成 150px）
    expect(el.style.height).toBe('600px')
    expect(el.style.maxWidth).toBe('100%')
  })

  it('宽度是百分比、calc() 等非像素值时不当成 px 处理', () => {
    for (const width of ['100%', 'calc(100% - 2rem)', '50vw', 'auto']) {
      const el = makeIframe({ width, height: '400' })
      applyResponsiveIframeSizing(el)
      expect(el.style.width).toBe('')
      expect(el.style.aspectRatio).toBe('')
    }
  })

  it('拒绝 0 与负数（会算出退化的比例）', () => {
    const el = makeIframe({ width: '0', height: '500' })
    applyResponsiveIframeSizing(el)
    expect(el.style.aspectRatio).toBe('')
    expect(el.style.width).toBe('')
  })

  // 这一组是「视频高度很矮」的正解：源站只说宽度不说高度
  describe('播放器没有声明高度时补 16:9', () => {
    it('width="100%" 的 B 站播放器铺满容器 + 16:9（修复 1104×150 的横条）', () => {
      const el = makeIframe({
        src: 'https://player.bilibili.com/player.html?bvid=BV1xx',
        width: '100%',
        allowfullscreen: 'true',
        class: 'ithome_video bilibili'
      })
      applyResponsiveIframeSizing(el)

      expect(el.style.width).toBe('100%')
      expect(el.style.height).toBe('auto')
      expect(el.style.aspectRatio).toBe('16 / 9')
      expect(el.style.maxWidth).toBe('100%')
    })

    it('一个尺寸都没给的播放器同样补 16:9', () => {
      const el = makeIframe({ src: 'https://www.youtube.com/embed/abc' })
      applyResponsiveIframeSizing(el)

      expect(el.style.width).toBe('100%')
      expect(el.style.aspectRatio).toBe('16 / 9')
    })

    it('只给了像素宽的播放器也铺满（源站的 640 是它自己的窄栏宽度）', () => {
      const el = makeIframe({ src: 'https://www.bilibili.com/blackboard/html5mobileplayer.html', width: '640' })
      applyResponsiveIframeSizing(el)

      expect(el.style.width).toBe('100%')
      expect(el.style.aspectRatio).toBe('16 / 9')
    })

    it('否定式：认不出的嵌入仍然不猜高度', () => {
      const el = makeIframe({ src: 'https://example.com/poll/3' })
      applyResponsiveIframeSizing(el)

      expect(el.style.width).toBe('')
      expect(el.style.height).toBe('')
      expect(el.style.aspectRatio).toBe('')
    })
  })

  it('清掉源站的绝对定位：Ghost 那套 JS 计算的嵌入在阅读器里会把播放器叠成一摞', () => {
    // Ghost 导出：外层 figure 的高度由它们的脚本写，脚本不在时 figure 塌成 0
    const el = makeIframe({}, 'position: absolute; top: 0; left: 0; width: 720px; height: 405px')
    applyResponsiveIframeSizing(el)

    expect(el.style.position).toBe('static')
    expect(el.style.getPropertyPriority('position')).toBe('important')
  })
})

describe('sanitizeEntryHtml 给 iframe 补响应式尺寸', () => {
  const context = {
    siteUrl: 'https://example.com',
    entryUrl: 'https://example.com/post/1'
  }

  it('与订阅源同源的视频嵌入按声明比例铺满容器', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="https://example.com/player.html" width="800" height="500"></iframe>',
      context
    )
    const frame = parseIframe(out)!
    expect(frame.style.aspectRatio).toBe('800 / 500')
    expect(frame.style.width).toBe('100%')
    expect(frame.style.maxWidth).toBe('100%')
    // 原有的懒加载不受影响
    expect(frame.getAttribute('loading')).toBe('lazy')
  })

  it('白名单里的第三方播放器同样处理（手机端最常见的那条路径）', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="//player.bilibili.com/player.html?bvid=BV1xx" width="1080" height="608" allowfullscreen></iframe>',
      { ...context, urlPrefixes: ['https://player.bilibili.com/player.html'] }
    )
    const frame = parseIframe(out)!
    expect(frame.style.aspectRatio).toBe('1080 / 608')
    expect(frame.hasAttribute('allowfullscreen')).toBe(true)
  })

  it('白名单里的播放器只写 width="100%" 时补 16:9（B 站 / IT 之家导出的形态）', () => {
    const out = sanitizeEntryHtml(
      '<iframe src="https://player.bilibili.com/player.html?bvid=BV1xx" width="100%" allowfullscreen="true"></iframe>',
      { ...context, urlPrefixes: ['https://player.bilibili.com/player.html'] }
    )
    const frame = parseIframe(out)!
    expect(frame.style.width).toBe('100%')
    expect(frame.style.aspectRatio).toBe('16 / 9')
    // 高度必须回到 auto，否则 aspect-ratio 被写死的高度压住
    expect(frame.style.height).toBe('auto')
  })

  it('没有尺寸的非播放器嵌入不被强行撑满一行', () => {
    const out = sanitizeEntryHtml('<iframe src="https://example.com/poll/3"></iframe>', context)
    const frame = parseIframe(out)!
    expect(frame.style.width).toBe('')
    expect(frame.style.aspectRatio).toBe('')
  })
})
