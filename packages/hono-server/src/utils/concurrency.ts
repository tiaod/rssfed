/**
 * 有限并发处理任务。
 *
 * 用途：批量导入 OPML、批量退订清理这类「几百个小操作」的场景 —— 串行太慢，
 * `Promise.all` 一把梭又会同时打满目标（外网站点 / CouchDB）。
 *
 * 实现上起 `limit` 个 worker 共享一个游标，而不是把数组切片分批：
 * 切片版本会让慢任务拖住整批（Map 顺序与完成顺序无关，但 batch 内要等最慢的那个）。
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const effective = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const workers = Array.from({ length: effective }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      await fn(item, index)
    }
  })
  await Promise.all(workers)
}
