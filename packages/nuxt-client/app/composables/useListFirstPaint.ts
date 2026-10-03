import { ref } from 'vue'

export interface ListFirstPaintOptions {
  /** 查一次本地库并整体替换列表（`useSyncedEntryList` 的 `load`） */
  load: () => Promise<void>
  /** 上屏之后列表里有没有内容（`load` 完成后调用） */
  hasEntries: () => boolean
  /**
   * 优先同步这个列表包含的源（`usePouchDb` 的 `syncPriority`）。
   *
   * 契约：不抛错、有等待上限。超时后复制仍在后台跑，剩下的条目照旧走提示条。
   */
  sync: () => Promise<unknown>
}

/**
 * 列表页的首屏策略：**先上屏，再优先同步**。
 *
 * 两条分支，判据只有一个 —— 本地有没有缓存：
 *
 *   - **有缓存**：立刻把本地内容渲染出来，一个请求都不等；优先同步丢到后台跑。之后拉到的
 *     新条目走折叠的「已同步 N 条」提示条（见 `useSyncedEntryList` / `NewEntriesBanner`），
 *     用户点「查看」才换列表 —— 正在读的内容永远不会被同步推走。
 *   - **没有缓存**：这时列表只有「暂无条目」可看，等同步反而更好，所以一直显示「加载中…」
 *     并等优先同步跑完（最多 5s，见 `syncPriority`）再渲染，把刚拉到的条目**直接**上屏、
 *     不折叠成提示条。
 *
 * 边界：没缓存又超时（首轮同步一个很大的源、网络又慢）时，会按现有内容渲染一次，剩下的条目
 * 之后仍走提示条 —— 宁可先给用户一个可点的「已同步 N 条」，也不要让页面一直白着。
 *
 * 判据必须在 `load()` 之后取：`useSyncedEntryList` 的列表是一份快照，只有它才知道
 * 「本地到底有没有东西可读」。这也是 `loading` 放在这里的理由 —— 有没有内容决定了
 * 首屏要不要等。
 */
export function useListFirstPaint(options: ListFirstPaintOptions) {
  /** 首屏是否仍在准备（模板据此显示「加载中…」） */
  const loading = ref(true)

  /** 进入列表时调用一次：先上屏，再按需等优先同步 */
  async function renderFirstPaint(): Promise<void> {
    // ① 本地缓存先上屏：不挡阅读，也不让同步把首屏堵住
    await options.load()
    const cached = options.hasEntries()

    // ② 优先同步在后台跑。有缓存时**不等它**：新条目折叠进提示条，由用户决定何时换列表
    const syncing = options.sync().catch(() => undefined)
    if (cached) {
      loading.value = false
      void syncing
      return
    }

    // ③ 没有缓存：loading 保持住（否则先闪一个「暂无条目」空态），等它跑完再渲染一次，
    //    把刚同步到的内容直接上屏。等待有上限（见 syncPriority），不会一直挂着。
    await syncing
    await options.load()
    loading.value = false
  }

  return { loading, renderFirstPaint }
}
