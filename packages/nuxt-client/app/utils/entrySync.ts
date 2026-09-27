/**
 * 后台同步拿到的新条目如何进入「正在阅读的列表」——这套判断的纯函数部分。
 *
 * 问题：条目列表按发布时间倒序展示，一次同步完成就整体替换 `entries` 时，
 * 新条目会插到头部，把用户正在读的内容往下推（滚动位置漂移）。
 *
 * 策略：只有「头部没有新增」的变化才静默上屏（内容更新、尾部新增、条目删除都不会
 * 移动用户正在读的位置）；头部有新增时转为「N 条新内容」提示，等用户点击再上屏。
 */

/** 一次窗口查询结果相对当前列表的变化性质 */
export interface HeadDiff {
  /** 有新条目排到了当前列表已展示内容之前：直接上屏会推走用户正在读的位置 */
  insertedAtHead: boolean
  /** 新窗口里当前列表中不存在的条目数（提示条文案用） */
  addedCount: number
}

/**
 * 比较当前列表与新查询结果的 id 序列。
 *
 * 用「公共前缀」而不是「集合是否相等」判断：新条目的发布时间可能很旧（源补录旧文），
 * 它会排到列表中间——那同样会把用户正在读的内容推下去，也应当转成提示。
 */
export function diffEntryHeads(currentIds: string[], nextIds: string[]): HeadDiff {
  const known = new Set(currentIds)
  let addedCount = 0
  for (const id of nextIds) {
    if (!known.has(id)) addedCount++
  }

  let prefix = 0
  while (
    prefix < currentIds.length
    && prefix < nextIds.length
    && currentIds[prefix] === nextIds[prefix]
  ) {
    prefix++
  }

  return {
    // 前缀没走完当前列表，说明当前列表的某一条之前被插进了别的内容。
    // 注意不能用「当前条目是否全部还在」来排除替换：查询窗口是定长的（如最新 50 条），
    // 头部插进来的新条目必然把最旧的几条挤出窗口，那样判定会恒为 false，保护就失效了。
    insertedAtHead: addedCount > 0 && prefix < currentIds.length,
    addedCount
  }
}

/**
 * 从新窗口里去掉「排到当前列表已展示条目之前」的新条目，只保留尾部扩展；
 * 并把当前列表里被挤出窗口的条目接回末尾，避免列表凭空缩短。
 *
 * 用于加载更多（无限滚动）与「已往下读」时的同步刷新：用户主动往下翻，但可能同时有
 * 后台同步的头部新增，此时窗口变大要接上尾部条目，头部新增仍留给提示条，不移动阅读位置。
 */
export function withStableHead<T extends { id: string }>(current: T[], next: T[]): T[] {
  // 当前列表为空（首屏）时不存在「头部新增」，整窗照收
  if (current.length === 0) return next

  const known = new Set(current.map(e => e.id))
  // 当前列表里最后一条在新窗口中的下标：排在它之后的才算尾部扩展
  let lastKnownIdx = -1
  for (let i = 0; i < next.length; i++) {
    if (known.has(next[i]!.id)) lastKnownIdx = i
  }
  const visible = next.filter((entry, i) => known.has(entry.id) || i > lastKnownIdx)

  // 补齐被窗口挤出的当前条目（定长窗口下头部插入会挤掉最旧几条）
  const visibleIds = new Set(visible.map(e => e.id))
  for (const entry of current) {
    if (!visibleIds.has(entry.id)) {
      visible.push(entry)
      visibleIds.add(entry.id)
    }
  }
  return visible
}
