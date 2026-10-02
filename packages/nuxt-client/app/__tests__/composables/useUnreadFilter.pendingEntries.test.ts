import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { useSyncedEntryList } from '../../composables/useSyncedEntryList'
import { useUnreadFilter } from '../../composables/useUnreadFilter'
import type { ScanCursor, ScanPage } from '../../composables/usePouchDb'
import type { RssEntry } from '../../types/rss'

/**
 * 「切『只看未读』和『已同步 N 条』提示条是什么关系？」——把两个 composable 按页面接法拼起来钉住。
 *
 * 页面里的三根线：
 *
 *   - 提示条「查看」→ useSyncedEntryList.applyNew()（重查快照、上屏、计数归零）
 *   - 「只看未读」开关 → useUnreadFilter.toggleUnreadOnly()（换列表来源 + 从头重扫）
 *   - 同步完成 → useSyncedEntryList.refreshFromSync()（只累计提示条条数）
 *
 * 定下来的语义：**列表是快照，未读模式是一次完整刷新**。
 *   - 列表那份快照不受同步影响（同步不推走正在读的内容，见 useSyncedEntryList）；
 *   - 但「只看未读」是用户主动切模式，扫描从本地库最新一条开始、不受快照约束 —— 同步刚写进来、
 *     还没点「查看」的条目，切进来就能看到。这正是用户实测到的「点一下开关，折叠的条目就展开了」；
 *   - 于是未读模式下「已同步 N 条」提示条整条收起（见 useEntriesBannerVisibility 的 suppressed），
 *     而这个计数不会被消费，切回「全部」时照旧出现。
 *
 * 假本地库的 scan 语义与 usePouchDb 的 scan*Page 一致：首轮无游标 = 从库头（最新）开始，
 * cursor 之后的下一行接着扫。
 */

const nuxtGlobals = globalThis as unknown as Record<string, unknown>
nuxtGlobals.ref = ref
const stateCache = new Map<string, Ref<unknown>>()
nuxtGlobals.useState = vi.fn(<T>(key: string, init: () => T) => {
  if (!stateCache.has(key)) stateCache.set(key, ref<T>(init()) as Ref<unknown>)
  return stateCache.get(key) as Ref<T>
})

const modal = { isOpen: ref(false), currentEntry: ref<RssEntry | null>(null) }
nuxtGlobals.useEntryModal = () => ({
  isOpen: modal.isOpen,
  currentEntry: modal.currentEntry,
  entries: computed(() => []),
  openEntry: vi.fn(),
  closeEntry: vi.fn(),
  goPrev: vi.fn(),
  goNext: vi.fn(),
  canGoPrev: computed(() => false),
  canGoNext: computed(() => false),
  isLastWithNoMore: () => false
})

function makeEntry(i: number): RssEntry {
  return {
    id: `e${i}`,
    feedId: 'feed-1',
    title: `标题 ${i}`,
    url: `https://example.com/${i}`,
    // i 越小越新
    publishedAt: new Date(Date.UTC(2026, 0, 1) - i * 3600_000).toISOString(),
    insertedAt: new Date(Date.UTC(2026, 0, 1) - i * 3600_000).toISOString(),
    feed: { id: 'feed-1', title: '源', siteUrl: '', feedUrl: '', lastFetchedAt: '' },
    starred: false,
    read: false,
    readingTime: 0
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
async function settle() {
  await nextTick()
  await flush()
  await nextTick()
  await flush()
}

const idsOf = (list: RssEntry[]) => list.map(e => e.id)

/** 按页面接法把两个 composable 拼起来；`deliver` 模拟同步把一条新文档写进本地库 */
function setupPage() {
  let db = [makeEntry(1), makeEntry(2), makeEntry(3)]
  let syncedDocs = db.length
  const readIds = new Set<string>()

  const list = useSyncedEntryList({
    query: async limit => db.slice(0, limit).map(e => ({ ...e, read: readIds.has(e.id) })),
    syncedDocs: () => syncedDocs
  })

  const scan = vi.fn(async (
    cursor: ScanCursor | null,
    limit: number
  ): Promise<ScanPage<ScanCursor>> => {
    let startIdx = 0
    if (cursor) {
      const idx = db.findIndex(e => e.id === cursor.id)
      startIdx = idx === -1 ? 0 : idx + 1
    }
    const rows = db.slice(startIdx, startIdx + limit).map(e => ({ ...e, read: readIds.has(e.id) }))
    const last = rows[rows.length - 1]
    return {
      rows,
      cursor: last ? { ms: Date.parse(last.publishedAt), id: last.id } : { ms: 0, id: '' },
      exhausted: rows.length < limit
    }
  })

  const filter = useUnreadFilter<ScanCursor>({
    entries: list.entries,
    hasMore: () => list.hasMore.value,
    grow: () => list.grow(),
    scan,
    enrich: async rows => rows
  })

  return {
    list,
    filter,
    scan,
    readIds,
    /** 同步写入一条新条目（按 publishedAt 落位），并让「已同步 N 条」跟着涨 */
    deliver: (entry: RssEntry) => {
      db = [...db, entry].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      syncedDocs += 1
      list.refreshFromSync()
    }
  }
}

beforeEach(() => {
  stateCache.clear()
  modal.isOpen.value = false
  modal.currentEntry.value = null
  window.scrollTo = (() => {}) as typeof window.scrollTo
})

describe('切「只看未读」= 一次完整刷新，且不动列表快照与提示条计数', () => {
  it('同步刚到的新条目：切进来就在列表里（不必先点「查看」）', async () => {
    const { list, filter, scan, deliver } = setupPage()
    await list.load()
    expect(idsOf(list.entries.value)).toEqual(['e1', 'e2', 'e3'])

    // 同步把 e0 写进本地库：只累计提示条条数，列表快照一个字没动
    deliver(makeEntry(0))
    expect(list.newCount.value).toBe(1)
    expect(idsOf(list.entries.value)).toEqual(['e1', 'e2', 'e3'])

    filter.toggleUnreadOnly()
    await settle()

    expect(filter.unreadOnly.value).toBe(true)
    // 完整刷新：e0 虽是刚同步进来的，也照样在未读列表里
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])
    // 首轮无游标 = 交给 scan 层从本地库最新一条开始
    expect(scan.mock.calls[0]![0]).toBeNull()
    // 列表快照与提示条计数都不受影响（计数没被消费，切回「全部」时照旧出现）
    expect(idsOf(list.entries.value)).toEqual(['e1', 'e2', 'e3'])
    expect(list.newCount.value).toBe(1)
  })

  it('关掉再打开：仍是完整刷新（每次都从最新重扫）', async () => {
    const { list, filter, deliver } = setupPage()
    await list.load()
    deliver(makeEntry(0))

    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])

    filter.toggleUnreadOnly() // 关
    await settle()
    expect(filter.unreadOnly.value).toBe(false)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e1', 'e2', 'e3']) // 回到快照

    filter.toggleUnreadOnly() // 再开
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])
    expect(list.newCount.value).toBe(1)
  })

  it('未读模式下又同步进一条：不再自动上屏（要再切一次开关刷新），但计数继续累计', async () => {
    const { list, filter, deliver } = setupPage()
    await list.load()
    deliver(makeEntry(0))

    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])

    // 未读模式里后台又写进一条更新的 e-1
    deliver({ ...makeEntry(0), id: 'e-1', publishedAt: new Date(Date.parse(makeEntry(0).publishedAt) + 60_000).toISOString() })
    await settle()

    expect(idsOf(filter.visibleEntries.value)).not.toContain('e-1')
    expect(list.newCount.value).toBe(2)

    // 再切一次开关 = 再刷新一次，新条目这才上来
    filter.toggleUnreadOnly()
    filter.toggleUnreadOnly()
    await settle()
    expect(idsOf(filter.visibleEntries.value)).toContain('e-1')
  })

  it('列表快照被「查看」换掉时，未读列表不重扫（扫描本来就不看快照）', async () => {
    const { list, filter, scan, deliver } = setupPage()
    await list.load()
    deliver(makeEntry(0))

    filter.toggleUnreadOnly()
    await settle()
    const callsAfterProbe = scan.mock.calls.length

    // 用户在「全部」下点了「查看」的场景：快照整体换新
    await list.applyNew()
    await settle()

    expect(idsOf(list.entries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])
    expect(list.newCount.value).toBe(0)
    expect(scan.mock.calls.length).toBe(callsAfterProbe)
    expect(idsOf(filter.visibleEntries.value)).toEqual(['e0', 'e1', 'e2', 'e3'])
  })
})
