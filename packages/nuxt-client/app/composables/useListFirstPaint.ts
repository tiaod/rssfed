import { computed, ref } from 'vue'

export interface ListFirstPaintOptions {
  /** 查一次本地库并整体替换列表（`useSyncedEntryList` 的 `load`） */
  load: () => Promise<void>
  /**
   * 优先同步这个列表要看的内容（`usePouchDb` 的 `syncPriority`：催一次服务端聚合 +
   * 等 live 复制把这一批送到本地）。
   *
   * 契约：不抛错、有等待上限（超时后复制仍在后台跑，剩下的条目照旧走提示条）。
   * **不传**表示这个页面没有优先同步（收藏页 / 历史页只查本地），只借这里的首屏节流。
   */
  sync?: () => Promise<unknown>
  /**
   * 骨架的延迟窗口（毫秒，默认 120）。
   *
   * 它不是「等这么久才开始渲染」，而是「本地查询超过这么久还没回来才画骨架」：
   * 本地库查询通常几十毫秒就回来，直接闪一帧骨架比什么都不显示更晃（骨架出现又立刻被
   * 内容替换，看起来就是屏幕闪了一下）。所以这个延迟只用来挡掉「快到看不见的等待」，
   * 慢查询该显示骨架的时候一分钟都不多等。
   */
  skeletonDelayMs?: number
}

/** 骨架延迟的默认值：落在「本地查询正常几十毫秒」与「真的慢到需要给个提示」之间 */
const DEFAULT_SKELETON_DELAY_MS = 120

/**
 * 列表页的首屏策略：**内容优先 —— 本地库第一批查询回来就上屏，同步全程在后台**。
 *
 * 只有一条规则：`loading` 表示「**本地库的第一批查询还没回来**」，`load()` 一结束就放掉，
 * 与同步跑没跑完无关。于是页面上：
 *
 *   - `loading` 期间内容区画骨架（`showSkeleton`，带一个短延迟，见下）；
 *   - `loading` 结束就是真实内容：有缓存显示缓存、没缓存显示空态，**都不会再多等一个请求**；
 *   - 优先同步丢到后台跑完为止。它拉到的条目照旧折叠进「已同步 N 条」提示条
 *     （见 `useSyncedEntryList` / `NewEntriesBanner`），用户点「查看」才换列表。
 *
 * 这里是从「没缓存 → 等同步 → 再自动上屏」改过来的：那条老路径会让离线首屏最多空转 5s
 * （改前 `waitForTimelineActivity` 只轮询「有没有新写入」，不看同步是否已经失败，离线时白等满
 * `PRIORITY_SYNC_WAIT_MS`），而且「等」期间页面只有一个转圈。现在**同步永远不挡首屏**，代价是
 * 「本地空、同步到第一批」这个场景也不再自动把内容顶上去，改由提示条负责（边界见下）。
 *
 * **空列表边界**：本地空的、同步随后带来第一批条目时，这里**不**自动 `load()` 把内容顶上去，
 * 而是交给提示条。核对过四个会优先同步的列表页（时间线 / 单源 / 分组 / bot 产出）：提示条都
 * 渲染在「空态 / 列表」分支**之外**（浮层挂在列表锚点容器下，见各页模板），列表空着时它照样
 * 在顶部浮出、`inert` 摘除、可点「查看」—— 用户因此有入口把内容刷出来，不需要「列表为空才自动
 * 上屏」的例外。收藏页 / 历史页没有优先同步，也就没有这个问题。
 *
 * 只留一条例外级的保证：`load()` 抛错时也照样把 `loading` 放掉（页面自己接住错误去提示），
 * 否则一次查询异常就会把首屏永久停在骨架上。
 */
export function useListFirstPaint(options: ListFirstPaintOptions) {
  const skeletonDelayMs = options.skeletonDelayMs ?? DEFAULT_SKELETON_DELAY_MS

  /** 首屏数据是否还在准备：**只在本地库第一批查询还没回来时为 true** */
  const loading = ref(true)
  /** 骨架延迟窗口是否已过（只有过了才允许把骨架画出来） */
  const delayElapsed = ref(false)
  /**
   * 模板据此决定要不要画骨架。两个条件缺一不可：还在等本地查询、且已经等超过延迟。
   *
   * 初值 false 是**有意**的：SSR 与客户端首帧都渲染「没有骨架」的占位容器，两边一致，
   * 不会因为 `loading` 为 true 就先把骨架画进 HTML 再在 120ms 后撤掉。
   */
  const showSkeleton = computed(() => loading.value && delayElapsed.value)

  // 延迟定时器：查询一结束就清掉，所以「很快就回来」的那次不会留下任何残余动作。
  // 页面在查询途中被卸载时不做额外清理：这时它只是把一个已经没人再读的 ref 置 true。
  let timer: ReturnType<typeof setTimeout> | null = null

  function stopDelay() {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  /** 优先同步丢到后台：不 await、不抛错（契约见 ListFirstPaintOptions.sync） */
  function backgroundSync() {
    const sync = options.sync
    if (!sync) return
    try {
      void Promise.resolve(sync()).catch(() => undefined)
    } catch {
      // 同步自己失败不影响首屏：页面已有同步状态指示（ListActionsBar / SyncButton）
    }
  }

  /** 进入列表时调用一次：本地库先上屏，同步丢后台 */
  async function renderFirstPaint(): Promise<void> {
    // ① 起骨架延迟窗口：超过它还没回来才画骨架，好让几十毫秒就结束的查询一次都不闪
    stopDelay()
    delayElapsed.value = false
    timer = setTimeout(() => {
      timer = null
      delayElapsed.value = true
    }, skeletonDelayMs)

    try {
      // ② 本地库第一批查询：`loading` 只负责这一件事，它一结束就放掉
      await options.load()
    } finally {
      stopDelay()
      loading.value = false
    }

    // ③ 上屏之后再催同步。**不等它**：等待会把「点进一个列表」重新变成「等一次同步」，
    //    而新条目本来就有提示条兜着（用户点「查看」才换列表，正在读的内容不会被推走）。
    backgroundSync()
  }

  return { loading, showSkeleton, renderFirstPaint }
}
