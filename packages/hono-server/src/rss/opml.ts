import { parseOpml as feedsmithParseOpml } from "feedsmith"

/** OPML 中解析出的单个订阅源 */
export interface OpmlFeed {
  /** 订阅地址（outline 的 xmlUrl 属性） */
  url: string
  /** 显示名（取 title 优先，其次 text，兜底为 url） */
  title: string
  /** 所属分组（由父级 outline 的 text/title 推导，无分组时缺省） */
  category?: string
}

/**
 * 使用 feedsmith 解析 OPML，提取所有订阅源及其分组。
 *
 * feedsmith 的 parseOpml 返回保留嵌套结构的 outline 树：
 * - 带 xmlUrl 的 outline 为订阅源
 * - 不带 xmlUrl 的为分组节点，其 text/title 作为子节点的分组名
 * 递归遍历树即可提取订阅源 + 分组，无需手动重建父子关系。
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const doc = feedsmithParseOpml(xml)
  const feeds: OpmlFeed[] = []
  for (const outline of doc.body?.outlines ?? []) {
    walkOutline(outline, undefined, feeds)
  }
  return feeds
}

/** 递归遍历 outline 树，收集订阅源 */
function walkOutline(node: any, parentCategory: string | undefined, feeds: OpmlFeed[]) {
  const url = node.xmlUrl
  if (url) {
    // 带 xmlUrl 的节点即订阅源
    feeds.push({
      url,
      title: node.title || node.text || url,
      category: parentCategory,
    })
    return
  }
  // 否则视为分组节点，取其标题作为子节点的分组
  const category = node.title || node.text || parentCategory
  for (const child of node.outlines ?? []) {
    walkOutline(child, category, feeds)
  }
}
