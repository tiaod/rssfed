/**
 * 本地条目 map view（浏览器端 PouchDB 执行，返回的都是文档字符串——纯数据，无 Nuxt 依赖）。
 *
 * 替代 Mango：PouchDB 9.0.0 的 find 对自建索引没法可靠做 desc 排序（会回退默认索引报错），
 * 而 db.query 的视图天然支持 descending + limit，索引 B 树按 key 分支扫描，desc 取前 L 条
 * 只经手窗口大小的行，不把巨量文档拉进 JS 内存整排（旧实现是 find 一次拉 1 万条再排）。
 *
 * key 设计：
 *   timeline：[发布时间(ms), _id]
 *   by_feed ：[feedId, 发布时间(ms), _id]
 * value 只投影列表所需字段，不携带正文全文（content），避免把大字段读进内存。
 *
 * 注意：PouchDB 不会自动重建已存在的视图，改投影字段时要把 _id 的设计文档版本一起升级
 *（如 local_entries_v2）并在 CONFIGS 反映，否则老用户本地库仍走旧视图。
 */

export const LOCAL_VIEWS = (() => {
  const VALUE_EXPR = [
    '_id: doc._id',
    'feedId: doc.feedId',
    'title: doc.title',
    'url: doc.url',
    'publishedAt: doc.publishedAt',
    'insertedAt: doc.insertedAt',
    'author: doc.author',
    'categories: doc.categories',
    'description: doc.description',
    'images: doc.images'
  ].join(',\n          ')
  const mapFn = (keyExpr: string) => `function (doc) {
          if (doc && doc.type === 'entry' && typeof doc.publishedAt === 'string') {
            var ms = Date.parse(doc.publishedAt);
            if (!isNaN(ms)) {
              emit(${keyExpr}, {
          ${VALUE_EXPR}
              });
            }
          }
        }`
  return {
    _id: '_design/local_entries_v1',
    views: {
      timeline: { map: mapFn('[ms, doc._id]') },
      by_feed: { map: mapFn('[doc.feedId || \'\', ms, doc._id]') }
    }
  }
})()

export const TIMELINE_VIEW = 'local_entries_v1/timeline'
export const BY_FEED_VIEW = 'local_entries_v1/by_feed'

/** 单源/分组视图起扫的时间上限（配 desc 端点用来限定到某个 feed 桶内） */
export const VIEW_MAX_TS = Number.MAX_SAFE_INTEGER
