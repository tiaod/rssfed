# 同步弹层残留「已同步 0%」：定位与验证

> **留档说明**：本文原为 `report/sync-tooltip/RESULTS.md` —— 仓库根下一个未纳入版本控制的调研目录（`.gitignore` 忽略 `report/`），清理时移入 `docs/notes/` 留档。
> 文中列出的**复现脚本、截图与基准产物已随该次清理删除**（它们从未进入版本控制），结论与实测数字保留在本文。
> 仍然存在的原始证据清单见 [`docs/notes/README.md`](../README.md)。

时间：2026-10-04 · 环境：本机 dev（Nuxt :3000 + Hono :3001 + 本机 CouchDB），真浏览器（ego-browser，视口 1280×900），账号 `admin@example.com`。

## 现象

左下角同步指示器悬停弹层里，标题已经是「同步成功」，明细却还挂着一串上一轮的「已同步 0%」，
后面才是「上次同步：刚刚 / 共 69 个订阅源 / 点击立即同步」（用户截图见 `input.png`，放大见 `zoom.png`）。

## 复现（改前，真浏览器 DOM）

`document.querySelector` 取弹层内容（`.w-56.rounded-md > div`）的子节点：

```
[ " 同步成功",
  "已同步 0%",          <-- 上一轮残留，同步已结束还赖着不走
  "上次同步：刚刚",
  "共 484 个订阅源",
  "点击立即同步" ]
```

同步过程中同一条弹层里也实时可见残留（残留行插在「剩余 …」前面）：

```
[ " 正在同步", "已同步 0%", "剩余 172 / 484 个订阅源（65%）",
  "已同步 36%（840 条）", "即将完成（已同步 59 条）", "点击暂停同步" ]
```

## 原因

`SyncStatusIndicator.vue` 的明细行 `v-for` 用**行文本**当 `:key`：

```html
<span v-for="line in details" :key="line" class="text-muted">{{ line }}</span>
```

而文本会重复：并发复制上限是 2，两个源都还没报进度时两行都是「已同步 0%」。
重复 key 会让 Vue 的 keyed diff 走进 unknown-sequence 分支后把两个旧节点解析到**同一个**新节点上
（`keyToNewIndexMap` 只保留最后一个同 key 的下标），先被解析的那个节点就此失去引用、留在 DOM 里，
后续任何一次重渲染都看不到它，永远清不掉。开发模式对应 `[Vue warn]: Duplicate keys found during update`。

触发时机很常见：两个源都停在 0% → 其中一个先报进度（「剩余 …」的百分比同时前进），
两行不再相同、尾部也不同，正好落进那个分支；每撞一次多留一行，几百个源的长同步就能攒出一串。

## 修复

明细行是纯文本、没有身份，按位置取 key：`v-for="(line, i) in details"` + `:key="i"`（详见组件内注释）。

## 验证

1. 回归用例（先红后绿）：`app/__tests__/components/SyncStatusIndicator.test.ts` 的
   「明细行会重复时：重渲染不留孤儿节点」。改前该用例失败并打印重复 key 警告：

   ```
   → expected [ Array(4) ] to deeply equal [ Array(3) ]
     [ "已同步 0%", "剩余 2 / 2 个订阅源（15%）", "已同步 0%", "已同步 30%（60 条）" ]
   ```

   改后：`6 passed`，无警告。
2. 全量单测：`npx vitest run` → 56 文件 / 531 用例全绿；`npx nuxt typecheck`、`eslint` 均无输出。
3. 真浏览器端到端：清掉本地水位与索引库（`rssfed-synced-feeds-*`、`rssfed-sync-window-*` + IndexedDB）
   制造冷启动全量同步（486 个库），全程把弹层开着轮询：

   - 同步中：子节点 = 标题 + 「剩余 …」 + 明细行 + 「点击暂停同步」，无残留、无重复 key 警告；
   - 同步结束：子节点恰好 4 个 —— `同步成功 / 上次同步：刚刚 / 共 486 个订阅源 / 点击立即同步`
     （见 `after-success.png`）。

## 顺带观察（未改）

Reka 的 UTooltip 会在内容里额外渲染一个 `aria-hidden="true"` 的 `role="tooltip"` 隐藏 span
（按钮的 `aria-describedby` 指向它），它的内容是**打开那一刻的快照**、不随后续状态更新。
它被 `clip-path: inset(50%)` 裁成 1px 且 `aria-hidden`，既不可见也不进无障碍树，与本问题无关，未动。
