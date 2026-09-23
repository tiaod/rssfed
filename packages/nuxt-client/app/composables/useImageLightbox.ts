import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'

/** lightbox 里展示的一张图 */
export interface LightboxImage {
  src: string
  title?: string
}

/**
 * 正文图片点击放大（vue-easy-lightbox）。
 *
 * 替代了原来的 medium-zoom：后者只做「点击放大到全屏」，没有缩放/平移/多图切换；
 * vue-easy-lightbox 支持滚轮缩放、双指缩放、双击缩放、拖拽平移、旋转与多图切换。
 *
 * 对外只暴露状态 + attach/detach，由调用方在合适的时机挂载
 * （必须在图片 src 已换成本地 blob URL 之后，这样离线也能放大原图）。
 *
 * 注意：lightbox 只负责「展示」，不做净化 —— 图片地址来自已净化的正文 DOM。
 */
export function useImageLightbox(containerRef: Ref<HTMLElement | null | undefined>) {
  const visible = ref(false)
  const index = ref(0)
  const images = ref<LightboxImage[]>([])

  /** 已挂上的点击监听，重新 attach / 卸载时要摘干净，否则换文章后会累积 */
  let bound: Array<{ img: HTMLImageElement, onClick: (event: MouseEvent) => void }> = []

  /**
   * 给 lightbox 根元素补上 `data-dismissable-layer`。
   *
   * 正文嵌在 UModal 里，而 lightbox 为了全屏覆盖会 teleport 到 body —— 在 Reka UI
   * 的 DismissableLayer 眼里它属于「条目弹窗外部」，于是点它的按钮（翻页/缩放）
   * 会被判定为点击外部，把整个阅读弹窗一起关掉，lightbox 随之卸载。
   *
   * Reka UI 的判定（DismissableLayer/utils.ts 的 isLayerExist）是：
   * 收集页面上所有 `[data-dismissable-layer]`，按 DOM 顺序比较 —— 目标所在的图层
   * 比当前图层更靠后，就算「更上层的图层内部」。lightbox 是 body 的最后一个子元素，
   * 天然晚于 UModal 的 DialogContent，补上这个属性即可被正确识别。
   *
   * 注意：UModal 自己的 `dismissible` prop 在这里帮不上忙（它只 preventDefault
   * interactOutside，而实际触发关闭的是 pointerDownOutside），实测无效。
   */
  async function markAsDismissableLayer() {
    await nextTick()
    let el = document.querySelector('.vel-modal')
    if (!el) {
      // 极端情况下 lightbox 的 DOM 比 nextTick 晚一帧（例如带上过渡）
      await new Promise(resolve => requestAnimationFrame(resolve))
      el = document.querySelector('.vel-modal')
    }
    el?.setAttribute('data-dismissable-layer', '')
  }

  watch(visible, (isOpen, wasOpen) => {
    if (isOpen === wasOpen || !isOpen) return
    void markAsDismissableLayer()
  })

  /**
   * 接管 ESC。
   *
   * UModal（Reka UI Dialog）默认也响应 ESC 关闭自己；两个监听都在 document 上，
   * 按 ESC 会把图片和条目弹窗一起关掉。这里在 capture 阶段把事件吃掉，只关 lightbox；
   * 模板上给组件设了 esc-disabled，避免它自己也处理一次。
   */
  function onKeydownCapture(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !visible.value) return
    event.stopPropagation()
    event.preventDefault()
    visible.value = false
  }

  /**
   * 只收集「值得放大」的图。
   * RSS 正文里 1x1 追踪像素很常见，点开只会看到一个点，直接排除。
   */
  function pickZoomableImages(el: HTMLElement): HTMLImageElement[] {
    return Array.from(el.querySelectorAll('img')).filter((img) => {
      if (!img.getAttribute('src')) return false
      // complete 为真说明已加载完，这时 naturalWidth 才是真实尺寸；0 表示还没加载，保留
      const isTrackingPixel = img.complete && img.naturalWidth <= 1 && img.naturalHeight <= 1
      return !isTrackingPixel
    })
  }

  function attach() {
    detach()
    const el = containerRef.value
    if (!el) return

    const imgs = pickZoomableImages(el)
    if (imgs.length === 0) return

    // img.src 是浏览器解析后的绝对地址（含 blob:），可以直接交给 lightbox
    images.value = imgs.map(img => ({
      src: img.currentSrc || img.src,
      title: img.getAttribute('alt') || undefined
    }))

    imgs.forEach((img, i) => {
      const onClick = (event: MouseEvent) => {
        // attach 时图片可能还没加载完，这里再判一次：确认失败/1x1 追踪像素就不放大
        if (img.complete && img.naturalWidth <= 1 && img.naturalHeight <= 1) return
        event.preventDefault()
        index.value = i
        visible.value = true
      }
      img.style.cursor = 'zoom-in'
      img.addEventListener('click', onClick)
      bound.push({ img, onClick })
    })

    document.addEventListener('keydown', onKeydownCapture, true)
  }

  function detach() {
    for (const { img, onClick } of bound) {
      img.removeEventListener('click', onClick)
      img.style.removeProperty('cursor')
    }
    bound = []
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', onKeydownCapture, true)
    }
    // 正文换掉（或组件卸载）时强制关掉，避免 lightbox 还指着已被 revoke 的 blob URL
    visible.value = false
  }

  onScopeDispose(detach)

  return { visible, index, images, attach, detach }
}
