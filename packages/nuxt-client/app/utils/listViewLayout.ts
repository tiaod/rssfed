/**
 * 列表版式的布局参数：列数断点表、条目间距、表格行高。
 *
 * 纯数据 + 纯函数，无 Nuxt / 浏览器依赖，方便单测。
 *
 * 为什么从 EntryList 里提出来：列数是「同一个数字」，却被两处消费 —— 真实列表（虚拟化的
 * lanes，决定条目落哪一列）和首屏骨架（网格铺几列）。两处各写一份断点表，改一处忘一处就会
 * 出现「骨架单列、条目三列」的跳版，而那正是骨架屏最该避免的事。表格行高同理：真实表格的
 * 每一行高度和骨架行必须一致，否则加载完列表高度会整体弹一下。
 */

import type { ListView } from '~/utils/listViews'

/**
 * 各视图的列数断点表，与 app/assets/css/main.css 的 --breakpoint-3xl/4xl 及 Tailwind 默认断点一致。
 * 虚拟化必须由 JS 知道列数（lane 决定条目落哪一列），没法交给 CSS。按 minWidth 降序，首个命中生效。
 *
 * 列数刻意按视图分开：瀑布流在手机上也铺两列（卡片墙的密度感）；
 * 博客卡片要留大留白，手机单列、多列才在平板以上成立；
 * 紧凑列表永远单列；图片图块窄，手机上也放得下两列。
 */
export const VIEW_BREAKPOINTS: Record<ListView, ReadonlyArray<readonly [number, number]>> = {
  // 社交动态：手机与桌面都是同一条窄列（条目内部再居中限宽），列数恒定不影响断点
  social: [[0, 1]],
  // 瀑布流（图片/卡片墙）：手机上就给两列，卡片窄但信息密度高，和博客视图一眼能区分
  masonry: [
    [2560, 8], // 4xl
    [1792, 6], // 3xl
    [1536, 5], // 2xl
    [1280, 4], // xl
    [768, 3], // md（平板）
    [0, 2] // 手机
  ],
  // 博客视图：手机保持单列（卡片大、适合读），到平板/桌面才铺多列
  blog: [
    [1280, 3], // xl
    [768, 2], // md
    [0, 1]
  ],
  list: [[0, 1]],
  // 表格恒为单列，且走的是 Table 分支（不用泳道虚拟化）：这里只为枚举完整、不参与布局
  table: [[0, 1]],
  // 图片瀑布流：图块窄，手机上也能放两列
  image: [
    [1536, 5], // 2xl
    [1280, 4], // xl
    [1024, 3], // lg
    [0, 2]
  ]
}

/**
 * 各视图的条目间距（px）。
 *
 * 它同时是页头跨列宽度的换算依据（见 EntryList 的 headerSpanStyle），所以不能写死在模板 class 里。
 * 列表视图间距为 0：行与行靠 border 分隔，留缝反而不像列表。
 */
export const VIEW_GAP: Record<ListView, number> = {
  social: 0, // 条与条靠分隔线划分，留缝就不像信息流了
  masonry: 16,
  blog: 24,
  list: 0,
  table: 0, // 同上：表格分支不吃这个值
  image: 8
}

/**
 * 表格视图的行高（px）= 一行 text-sm（20）+ 上下内边距（td 的 p-4 被收到 py-2 → 16）+ 1px 分隔线。
 *
 * 不是主题默认的 53：表格一行只有标题 + 摘要，收紧后信息密度才像邮件列表。UTable 不逐行测量，
 * `tr` 直接被写成这个高度，所以它必须与单元格实际渲染出来的高度一致（骨架屏也照它排）。
 */
export const TABLE_ROW_HEIGHT = 37

/** 按视口宽度解析某视图的列数；表里首个 minWidth 命中生效，都不命中时至少一列 */
export function resolveLanes(width: number, view: ListView): number {
  for (const [minWidth, lanes] of VIEW_BREAKPOINTS[view]) {
    if (width >= minWidth) return lanes
  }
  return 1
}
