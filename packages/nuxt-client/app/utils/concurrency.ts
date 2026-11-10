/**
 * 有并发上限的批量异步映射。
 *
 * 为什么需要它：列表 enrich 要给一页里**每一条**条目读封面附件（`getAttachment` 一次一个
 * IndexedDB 往返）。串行做，尾延迟是一条一条累加（实测就是 enrich 段 40~110ms 里的主体）；
 * 但一次性并发几十个又会让 IndexedDB 的事务队列被占满，同一时刻的列表查询只能排在后面 ——
 * 等于用查询的首帧换附件的首帧，而「先出字、再出图」是要保住的顺序。
 *
 * 所以取一个中间值：并发数由调用方按数据源给，这里只保证「同时最多 N 个在跑、结果顺序与输入
 * 一致、异常原样抛出」。
 *
 * 不用 `Promise.all(items.map(chunk...))` 手写一遍：分块会让每块等最慢的那个，
 * 实际并发数在块尾会掉下来；这里用「谁跑完谁领下一个」的池子，吞吐更接近上限。
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  const results = new Array<R>(items.length)
  // 指针由所有工人共享：同步自增是安全的（JS 单线程），每个 index 只被领一次
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}
