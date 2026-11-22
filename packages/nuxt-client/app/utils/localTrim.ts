/**
 * 本地库「裁掉退订源条目」的判定与执行。
 *
 * 为什么需要裁剪：服务端用 `_purge` 裁剪源库与汇聚库（hono-server 的 `couchdb/retention.ts`），
 * 而 **`_purge` 掉的文档不进 `_changes`** —— 浏览器永远收不到「这条没了」的通知。于是本地这份
 * 只增不减：`db.compact()` 只能回收**非叶子修订**与**无人引用的附件**，对仍然活着的条目文档
 * 一个字节都回收不了。用户试订阅、退订阅留下的那些源的条目，会永久留在 IndexedDB 里。
 *
 * 为什么只裁**退订源**的条目（而不是「每个源只留 N 条」）：
 *   - 退订源的条目服务端已经不再投递，留着纯属垃圾，而且它还在污染时间线视图 ——
 *     本地视图不按订阅集合过滤（`local_entries_v1/timeline` 的 key 只有 `[ms, _id]`），
 *     所以**退订之后那些源的文章还会出现在时间线上**。裁掉它们顺手把这个 bug 也修了；
 *   - 「每源留 N 条」要跟服务端的自适应 N（10/20/30/50，见 `feed-retention-policy`）对齐，
 *     一旦客户端算小了，用户重置本地库后还得整份重下。收益却很小：云端每源本来就只有
 *     N 条，本地不会比云端多出多少。所以不做。
 *
 * 为什么删完必须 compact：PouchDB 的 IndexedDB adapter **没有实现 `_purge`**
 * （`AbstractPouchDB.prototype.purge` 会直接报 "Purge is not implemented in the idb adapter"），
 * 所以只能走标准删除 —— 留下墓碑，正文与附件字节要等 `compact()` 才真正还回去。
 *
 * 安全前提：本地删除**不会**传播到服务端。上行的 live 复制带 `isClientWritableDoc` 过滤器，
 * 而删除文档只剩 `_id` 与 `_deleted`、没有 `type` —— 所以那个过滤器必须按 `_id` 前缀判断
 * （见 usePouchDb 的同名函数），否则每次裁剪都会往服务端推一批必然被 403 拒掉的墓碑。
 */

/** 单批删除的文档数（与 hono-server 的 `DEFAULT_TRIM_BATCH` 同量级，避免一个巨型事务） */
export const TRIM_BATCH_SIZE = 200

/** 每轮最多删几批（= 单轮删除上限 2000 条），防止一轮把用户的 IO 全占满 */
export const TRIM_MAX_BATCHES = 10

/** 一轮裁剪最多动多少个退订源（退订几十个源的极端场景下分多轮收敛） */
export const TRIM_MAX_FEEDS = 50

/**
 * 从「本地视图里出现过的源」里挑出要裁的：**没有对应订阅文档**的那些。
 *
 * bot 订阅（`feedId` 形如 `bot:<botId>`）同样走 `subscription:` 文档，所以统一按订阅集合判断，
 * 不区分来源类型。
 */
export function selectFeedsToTrim(
  localFeedIds: readonly string[],
  subscribedFeedIds: ReadonlySet<string>
): string[] {
  const out: string[] = []
  for (const id of localFeedIds) {
    // 空 feedId 是历史脏数据（早期文档可能缺 feedId），按「无主」一并清掉
    if (id !== '' && subscribedFeedIds.has(id)) continue
    out.push(id)
    if (out.length >= TRIM_MAX_FEEDS) break
  }
  return out
}

/**
 * 从候选 id 里剔除「用户收藏过」的条目。
 *
 * 收藏是用户的明确意图，且量极小（实测一个大账号 1509 条状态里只有 2 条收藏）。
 * 历史页（`queryHistoryEntries`）**不**享受同样的保护：它把 `entry-state:*` 与 `entry:*`
 * 按 id join，条目不在本地时静默跳过 —— 而线上那个账号的 1509 条状态里已经有 1393 条
 * 指向**服务端早已 purge 掉的条目**，历史页本来就只显示得出 116 条。既然已读状态大面积
 * 失效是既有事实，就没必要为它保留正文与图片。
 */
export function excludeSaved(entryIds: readonly string[], savedEntryIds: ReadonlySet<string>): string[] {
  if (savedEntryIds.size === 0) return [...entryIds]
  return entryIds.filter(id => !savedEntryIds.has(id))
}

/** 把候选 id 切成删除批次（最后一批可以不满） */
export function chunkIds(ids: readonly string[], size = TRIM_BATCH_SIZE): string[][] {
  if (size <= 0) throw new Error('TRIM_BATCH_SIZE 必须为正数')
  const out: string[][] = []
  for (let i = 0; i < ids.length && out.length < TRIM_MAX_BATCHES; i += size) {
    out.push(ids.slice(i, i + size))
  }
  return out
}
