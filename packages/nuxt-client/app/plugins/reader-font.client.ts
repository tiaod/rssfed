import { loadReaderFontCss, readerFontStack } from '~/utils/readerFonts'

/**
 * 把「阅读字体」偏好应用到正文。
 *
 * 只做一件事：往 `<html>` 上写 `--font-reading`（作用域见 main.css 的 `.entry-prose`）。
 *  - 跟随系统：**移除**变量，正文落回 @theme 里声明的 `var(--font-sans)`；
 *  - 系统字体：直接写字体栈，浏览器按栈取第一个可用的族；
 *  - 自带字体：先等它的样式分片加载完再写，否则会先套回退字体、样式到位后再跳一下。
 *
 * 偏好存在 localStorage（见 useSettings），所以只在客户端生效：SSR 首帧用默认字体，
 * 客户端 hydration 后才替换，不会造成 hydration mismatch（代价是首屏有一次字体切换）。
 */
export default defineNuxtPlugin(() => {
  const { settings } = useSettings()

  async function apply(): Promise<void> {
    const stack = readerFontStack(settings.value.readerFont)

    if (!stack) {
      document.documentElement.style.removeProperty('--font-reading')
      return
    }

    try {
      await loadReaderFontCss(settings.value.readerFont)
    } catch {
      // 样式分片拿不到（首次选中时断网且没缓存）：仍然写字体栈，
      // 正文回退到栈里的系统字体，不影响阅读；下次联网再选中会重新尝试。
    }

    document.documentElement.style.setProperty('--font-reading', stack)
  }

  // immediate：刷新页面后要立刻恢复上次的选择，不能等用户再点一次设置
  watch(() => settings.value.readerFont, () => {
    void apply()
  }, { immediate: true })
})
