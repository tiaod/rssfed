# 随应用分发的字体：来源与许可

这个目录只放**许可文本**。字体文件本身不在这里 —— 它们来自 npm 依赖，由用户选中时按需加载
（清单见 `app/utils/readerFonts.ts`，加载见 `app/plugins/reader-font.client.ts`）。

## 霞鹜文楷屏幕阅读版（LXGW WenKai Screen）

| 项 | 值 |
| --- | --- |
| 上游 | [lxgw/LxgwWenKai-Screen](https://github.com/lxgw/LxgwWenKai-Screen)（OFL-1.1，v1.530） |
| 依赖 | `lxgw-wenkai-screen-web@1.530.0`（社区打包，CM_Bill，随上游发版跟进） |
| 用到的变体 | `lxgwwenkaigbscreen/`（GB 字形，即大陆规范写法；非 GB 变体是原风格半陆标，未引入） |
| 字体族名 | `LXGW WenKai GB Screen` |
| 许可 | SIL Open Font License 1.1，全文见 `OFL-LXGWWenKaiScreen.txt` |

## 为什么可以随网页分发

OFL 1.1 允许嵌入、复制与再分发（只禁止单独售卖字体本身），上游还在版权声明里给了
**附加许可（ADDITIONAL PERMISSION）**：为网页分发而对字体做子集化 / 转成 WOFF/WOFF2 的
修改版本，可以继续使用保留字体名（`霞鹜`、`霞鶩`、`落霞孤鹜`、`落霞孤鶩`、`LXGW`），
前提是这些修改版本**不能以可安装字体文件的形式提供**。

因此本项目：只把 woff2 分片发给浏览器（经 Vite 打进构建产物、由 Service Worker 按需缓存），
**不**在页面上提供 TTF/OTF/可安装字体下载。升级依赖时请同步更新本目录的 OFL 文本
（上游版权年份会随版本变）。

## 为什么字体不进预缓存

整套分片有 259 个 woff2（约 15MB）。放进 `/sw-manifest.json` 会让**每个**用户在安装 SW 时
全量下载；所以 `build/generate-sw-manifest.ts` 的 `shouldSkip` 把 `.woff2` 排除了。用户真正
读到正文时，`sw.js` 的 `STATIC_FILE_RE` 会按 cache-first 落缓存，之后离线可用（没读到的分片
离线时回退系统字体）。
