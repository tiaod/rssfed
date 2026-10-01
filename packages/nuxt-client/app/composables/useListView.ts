import { computed, onMounted, ref } from 'vue'
import { DEFAULT_LIST_VIEW, type ListView } from '~/utils/listViews'

/**
 * 列表视图的解析与切换。
 *
 * 默认值三层，越具体越优先：
 *   单源页（含 bot 产出页）：订阅源自身 -> 所属分组 -> 全局
 *   分组页：该分组 -> 全局
 *   时间线：全局（默认瀑布流）
 *
 * 页面上的切换按钮**只写会话内覆盖**（下面的 useState），刷新即回到配置的默认值：
 * 只有显式配置入口（通用设置 / 编辑订阅 / 订阅管理页的分组行）才写默认值，
 * 否则顺手点一下切换就等于改了配置，事后无从察觉。
 *
 * 用 useState 而不是组件内 ref 是有意的：会话内跨页面来回跳（时间线 -> 某个源 -> 返回）
 * 不该把用户刚选的视图丢掉，这正是「用户选了就记住、但不落盘」的含义。
 */

/** 会话内覆盖：contextKey -> view。刷新页面即清空。 */
function useViewOverrides() {
  return useState<Record<string, ListView>>('list-view-overrides', () => ({}))
}

/** 视图状态：生效值、配置默认值、是否被会话内切换覆盖，以及切换 / 撤销 */
export function useListViewState(contextKey: string, resolveDefault: () => ListView) {
  const overrides = useViewOverrides()

  const defaultView = computed<ListView>(() => resolveDefault())
  const view = computed<ListView>(() => overrides.value[contextKey] ?? defaultView.value)
  const overridden = computed(() => overrides.value[contextKey] !== undefined)

  function setView(next: ListView) {
    overrides.value = { ...overrides.value, [contextKey]: next }
  }

  /** 撤销会话内切换，回到配置的默认视图 */
  function resetView() {
    if (overrides.value[contextKey] === undefined) return
    const next = { ...overrides.value }
    Reflect.deleteProperty(next, contextKey)
    overrides.value = next
  }

  return { view, defaultView, overridden, setView, resetView }
}

/** 时间线：全局默认（默认瀑布流） */
export function useTimelineView() {
  const { settings } = useSettings()
  return useListViewState('timeline', () => settings.value.view ?? DEFAULT_LIST_VIEW)
}

/**
 * 单源页 / bot 产出页：订阅源自身 -> 所属分组 -> 全局。
 *
 * 两个偏好都来自用户状态库，客户端挂载后才拿得到；在此之前先按全局默认渲染，
 * 拿到值再切换（列表本身也要等本地查询，所以不会多一次可见的跳动）。
 */
export function useFeedView(feedId: string) {
  const pouch = usePouchDb()
  const { settings } = useSettings()
  const feedDefault = ref<ListView | null>(null)
  const groupDefault = ref<ListView | null>(null)

  /** 读一次订阅源 / 分组的默认值；编辑订阅之后重读一次，改动不用刷新页面就能生效 */
  async function refreshPrefs() {
    try {
      const prefs = await pouch.getSubscriptionViewPrefs(feedId)
      feedDefault.value = prefs.view
      groupDefault.value = prefs.category ? await pouch.getGroupView(prefs.category) : null
    } catch {
      // 读取失败按「未配置」处理，回退全局默认
    }
  }

  onMounted(refreshPrefs)

  return {
    ...useListViewState(
      `feed:${feedId}`,
      () => feedDefault.value ?? groupDefault.value ?? settings.value.view ?? DEFAULT_LIST_VIEW
    ),
    feedDefault,
    groupDefault,
    refreshPrefs
  }
}

/** 分组（文件夹）页：该分组 -> 全局 */
export function useGroupView(category: string) {
  const pouch = usePouchDb()
  const { settings } = useSettings()
  const groupDefault = ref<ListView | null>(null)

  onMounted(async () => {
    try {
      groupDefault.value = await pouch.getGroupView(category)
    } catch {
      // 读取失败按「未配置」处理，回退全局默认
    }
  })

  return {
    ...useListViewState(
      `group:${category}`,
      () => groupDefault.value ?? settings.value.view ?? DEFAULT_LIST_VIEW
    ),
    groupDefault
  }
}
