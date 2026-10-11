import { describe, it, expect } from 'vitest'
import { botHandle } from '../../utils/botHandle'

/**
 * Bot 的联邦地址展示：`@用户名@域名`。
 * 域名从 API 基址推导（resolveApiBase 会把 localhost 换成当前页面域名，局域网设备访问时
 * localhost 指向设备自己），这里盯住这两种情况。
 */
describe('botHandle', () => {
  it('默认拼 @用户名@域名', () => {
    expect(botHandle('alice', 'http://localhost:3001')).toBe('@alice@localhost:3001')
  })

  it('https 基址只取域名（含端口），拖尾斜杠不带进来', () => {
    expect(botHandle('alice', 'https://rss.example.com:8443/api/')).toBe('@alice@rss.example.com:8443')
  })

  it('局域网访问时用当前页面域名（手机上的 localhost 指向设备自己）', () => {
    // happy-dom 才有 happyDOM.setURL；类型里没有，按测试环境的最小接口转一次
    const happyDOM = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM
    const original = window.location.href
    try {
      happyDOM.setURL('http://192.168.1.5:3000/')
      expect(botHandle('alice', 'http://localhost:3001')).toBe('@alice@192.168.1.5:3001')
    } finally {
      happyDOM.setURL(original)
    }
  })
})
