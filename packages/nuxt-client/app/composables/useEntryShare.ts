import { ref } from 'vue'
import type { RssEntry } from '~/types/rss'
import { entryExcerpt } from '~/utils/entryDisplay'
import { errorMessage } from '~/utils/errorMessage'

/**
 * 主要输入是不是触屏（手机 / 平板）。
 *
 * 用 `pointer: coarse` 而不是 maxTouchPoints：触屏笔记本的主输入仍是鼠标（pointer: fine），
 * 那类设备上系统分享面板往往不如复制顺手，不该被当成手机。
 */
function isTouchPrimary(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
}

/**
 * 分享当前文章。
 *
 * 优先走浏览器 / 系统的 Web Share API（`navigator.share`）：手机上会弹出系统分享面板，
 * 可以直接发到微信、Telegram 等任意应用。桌面浏览器或非安全上下文（http）没有这个 API，
 * 退回复制原文链接 —— 分享这个动作总要有个结果，不能点了没反应。
 *
 * 分享方式由通用设置里的「分享方式」（ShareMethod）控制：
 *   - auto（默认）：触屏设备用系统面板（没有 API 时复制），桌面直接复制链接
 *   - system：始终尝试系统面板，不区分设备（没有 API 时仍回退复制）
 *   - clipboard：始终复制链接
 *
 * 与 useEntryActions 一样用取值函数：详情面翻篇时会换成另一篇，取值函数每次读当下那一条。
 * 分享的是**原文链接**（`entry.url`），不是应用内地址 —— 收件人不需要本应用也能打开。
 */
export function useEntryShare(getEntry: () => RssEntry | null | undefined) {
  const toast = useToast()
  const { copy } = useClipboard({ legacy: true })
  // 分享方式由用户在「通用设置」里选：桌面端的系统分享面板往往不如复制顺手
  const { settings } = useSettings()
  const shareBusy = ref(false)

  /** 用户自己在系统面板里取消分享（AbortError）：不是失败，也不该退回复制 */
  function isAbortError(e: unknown): boolean {
    return typeof e === 'object' && e !== null
      && (e as { name?: unknown }).name === 'AbortError'
  }

  /** 复制链接：Web Share API 缺席时的回退，也是分享面板调用失败后的保底 */
  async function copyLink(url: string) {
    try {
      // useClipboard 的 copy 在剪贴板不可用时返回 false（不抛错），两种失败都要兜住
      const copied = await copy(url)
      if (copied === false) throw new Error('剪贴板不可用')
      toast.add({ title: '链接已复制', description: '可以粘贴到任意地方分享', color: 'success' })
    } catch (e: unknown) {
      toast.add({ title: '复制失败', description: errorMessage(e, '无法写入剪贴板'), color: 'error' })
    }
  }

  async function share() {
    const entry = getEntry()
    if (!entry || shareBusy.value) return

    // RSS 条目可以没有 <link>（服务端落成空串，见 workers/index.ts），没有链接就无从分享
    if (!entry.url) {
      toast.add({ title: '无法分享', description: '这篇文章没有原文链接', color: 'neutral' })
      return
    }

    const url = entry.url
    const method = settings.value.shareMethod ?? 'auto'

    // 是否尝试系统分享面板：
    // clipboard 永不尝试；auto 只在触屏设备上尝试（桌面端复制更顺手）；system 不区分设备
    const preferSystem = method === 'system' || (method === 'auto' && isTouchPrimary())
    if (!preferSystem) {
      await copyLink(url)
      return
    }

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      shareBusy.value = true
      try {
        // text 放摘要（纯文本、已截断）：多数分享面板会把它当正文，部分平台还会自行把 url
        // 接在 text 后面。摘要为空（老条目 / 没有描述与正文）时不传该字段，而不是传空串。
        const text = entryExcerpt(entry, 120)
        const data: ShareData = { title: entry.title, url }
        if (text) data.text = text
        await navigator.share(data)
      } catch (e: unknown) {
        // 取消不算失败；其余失败（如权限被拒、系统面板不可用）退回复制，动作仍有结果
        if (!isAbortError(e)) await copyLink(url)
      } finally {
        shareBusy.value = false
      }
      return
    }

    // 要求了系统面板但没有 Web Share API（非安全上下文等）：复制链接保底
    await copyLink(url)
  }

  return { shareBusy, share }
}
