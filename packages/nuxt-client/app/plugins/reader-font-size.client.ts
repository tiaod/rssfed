import { readerFontSizeCss } from '~/utils/readerFontSize'

/**
 * 把「正文字号」偏好应用到正文。
 *
 * 与 reader-font.client.ts 同一套做法：只做一件事 —— 往 `<html>` 上写
 * `--reading-font-size`（作用域见 main.css 的 `.entry-prose`）。
 *  - 100%：**移除**变量，正文落回 @theme 里声明的 `1rem`；
 *  - 其它比例：换算成 rem 写进去；标题、代码块等用 em 的尺寸会按比例一起变（见 main.css）。
 *
 * 偏好存在 localStorage（见 useSettings），所以只在客户端生效：SSR 首帧用默认字号，
 * 客户端 hydration 后才替换，不会造成 hydration mismatch（代价是首屏有一次字号切换，
 * 与阅读字体一致）。
 */
export default defineNuxtPlugin(() => {
  const { settings } = useSettings()

  // immediate：刷新页面后要立刻恢复上次的选择，不能等用户再拖一次滑块
  watch(() => settings.value.readerFontScale, (scale) => {
    const size = readerFontSizeCss(scale)

    if (!size) {
      document.documentElement.style.removeProperty('--reading-font-size')
      return
    }

    document.documentElement.style.setProperty('--reading-font-size', size)
  }, { immediate: true })
})
