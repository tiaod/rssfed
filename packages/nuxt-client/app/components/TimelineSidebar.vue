<script setup lang="ts">
/**
 * 时间线右栏：同步健康 + 阅读小结。
 *
 * **只在「社交动态」视图出现**（判据见 utils/listViews 的 showsTimelineSidebar）：
 * 那个视图的正文列固定 `max-w-xl`(576px) 居中，右侧留白从布局里就存在，塞一栏进去是白捡
 * 的地方；瀑布流 / 博客 / 图片 / 表格 / 列表都是「一屏扫过很多条」的密版式，右栏会直接
 * 吃掉它们的列宽。所以这一栏属于视图而不属于页面 —— 切到别的视图就整块不渲染
 * （也顺带省掉那几轮数据请求，见 useTimelineSidebar 的挂载刷新）。
 *
 * 只存在于宽屏（xl 以上）：窄窗口里连内容列右侧的留白都不存在，强行塞进来会把正文挤到
 * 左边还挤不满。窄屏用页面顶部的动作区和左下角的同步指示器就够了（同一份数据，紧凑版）。
 *
 * 这一栏**不参与滚动**：它是「页面上一直看得见的一块」，随列表滚走的话用户永远得往下翻
 * 才能看到上次同步是什么时候。所以它自己 `sticky`，列表在左边独立滚。
 *
 * 为什么不做成可拖动 / 可折叠的第三栏（像 EntryReaderPane 那样）：那样要动布局、并处理与
 * 阅读栏抢同一个位置的问题；这里只是面板内的一块常驻区域，宽度固定就够用。
 *
 * 也因此**不再需要「阅读栏开着时让位」**：阅读栏只在「列表」视图 + 宽屏成立，而这一栏只在
 * 「社交动态」成立，两者永远不会同时出现（同一条 view 派生出的互斥判据）。
 */
import { computed } from 'vue'
import { useTimelineSidebar } from '~/composables/useTimelineSidebar'
import { useSettingsModal } from '~/composables/useSettingsModal'

const {
  syncState,
  syncLabel,
  lastSyncedText,
  cloudText,
  localText,
  problemSources,
  feedCount,
  refreshNow,
  refreshing,
  digest,
  digestLoaded
} = useTimelineSidebar()

const toast = useToast()

/**
 * 卡片右上角的手动刷新。
 *
 * 三件事缺一都像「点了没反应」（这正是它最早的毛病）：
 *   - 绕过 60 秒缓存（refreshNow 的 force），否则数字原样不动；
 *   - 按钮进入 loading（refreshing），几百毫秒里也有明确的进行中状态；
 *   - 结束后给一句 toast，让「已经刷过了」这件事留下痕迹。
 */
async function refresh() {
  const did = await refreshNow()
  if (!did) return
  toast.add({ title: '已刷新', description: '同步状态与阅读小结已重新读取', color: 'success' })
}

/**
 * 「查看同步日志」不再跳到 /profile?tab=1：它在原地打开设置弹窗的「数据」分区，
 * 并直接展开同步日志面板（意图见 useSettingsModal 的 wantTimelineLog）。
 */
const { openSyncLog } = useSettingsModal()

/**
 * 状态点配色：失败 / 存储故障一眼要能看出来，其余用中性色。
 * 与侧边栏的同步指示器同一套语义（都来自 utils/syncStatusSummary 的 state）。
 */
const dotClass = computed(() => {
  switch (syncState.value) {
    case 'error':
    case 'storage-error':
      return 'bg-error'
    case 'syncing':
      return 'bg-primary animate-pulse'
    case 'paused':
      return 'bg-warning'
    case 'success':
      return 'bg-success'
    default:
      return 'bg-muted'
  }
})
</script>

<template>
  <aside
    class="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto py-6 pe-6 ps-2 xl:flex"
    aria-label="时间线侧栏"
  >
    <!-- 同步健康 -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <span
            class="size-2 shrink-0 rounded-full"
            :class="dotClass"
            aria-hidden="true"
          />
          <h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted">
            {{ syncLabel }}
          </h3>
          <UTooltip text="重新读取（跳过缓存）">
            <UButton
              icon="i-lucide-refresh-cw"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="重新读取同步状态"
              :loading="refreshing"
              @click="refresh"
            />
          </UTooltip>
        </div>
      </template>

      <dl class="space-y-2 text-xs">
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted">
            上次同步
          </dt>
          <dd class="tabular-nums text-default">
            {{ lastSyncedText }}
          </dd>
        </div>
        <div
          v-if="feedCount > 0"
          class="flex items-baseline justify-between gap-3"
        >
          <dt class="text-muted">
            订阅源
          </dt>
          <dd class="tabular-nums text-default">
            {{ feedCount }} 个
          </dd>
        </div>
        <!--
          两个体积口径不同，必须分开写（见 useTimelineCloudInfo / useStorageEstimate 的头注释）：
          「云端」是活文档的外部字节（近似一次全量同步要过的量），「本站缓存」是整个 origin
          的占用，不是某一个库。
        -->
        <div
          v-if="cloudText"
          class="flex items-baseline justify-between gap-3"
        >
          <dt class="text-muted">
            云端库
          </dt>
          <dd class="tabular-nums text-default">
            {{ cloudText }}
          </dd>
        </div>
        <div
          v-if="localText"
          class="flex items-baseline justify-between gap-3"
        >
          <dt class="text-muted">
            本站缓存
          </dt>
          <dd class="tabular-nums text-default">
            {{ localText }}
          </dd>
        </div>
      </dl>

      <!--
        有问题的源单独列出来：这张卡真正的价值就在这 —— 汇总数字在左下角指示器里也有，
        但「哪个源悄悄失败了」只有这里会说。
      -->
      <div
        v-if="problemSources.items.length"
        class="mt-3 border-t border-default/60 pt-3"
      >
        <p class="text-xs font-medium text-error">
          有源同步失败
        </p>
        <ul class="mt-1.5 space-y-1">
          <li
            v-for="source in problemSources.items"
            :key="source.id"
            class="truncate text-xs text-muted"
            :title="source.title"
          >
            {{ source.title }}
          </li>
        </ul>
        <p
          v-if="problemSources.more > 0"
          class="mt-1 text-xs text-muted"
        >
          另有 {{ problemSources.more }} 个
        </p>
        <UButton
          variant="link"
          color="neutral"
          size="xs"
          trailing-icon="i-lucide-arrow-right"
          class="mt-1 px-0"
          @click="openSyncLog"
        >
          查看同步日志
        </UButton>
      </div>
    </UCard>

    <!-- 阅读小结 -->
    <UCard>
      <template #header>
        <h3 class="text-sm font-semibold text-highlighted">
          阅读小结
        </h3>
      </template>

      <!--
        先给「今天」，它是这张卡的主数字：用户打开时间线最想知道的是「我落下了多少」。
        周 / 累计跟在下面两行，作为趋势的参照 —— 排成标签在左、数字在右的清单，
        比 2×2 网格更容易竖着扫（中文标签宽度不一，网格里的数字会对不齐）。
      -->
      <div class="flex items-baseline gap-1.5">
        <span class="text-3xl font-semibold tabular-nums leading-none text-highlighted">
          {{ digestLoaded ? digest.today : '–' }}
        </span>
        <span class="text-xs text-muted">
          今天读过
        </span>
      </div>

      <dl class="mt-4 space-y-2 border-t border-default/60 pt-3 text-xs">
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted">
            最近 7 天
          </dt>
          <dd class="tabular-nums text-default">
            {{ digestLoaded ? digest.week : '–' }} 条
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted">
            累计读过
          </dt>
          <dd class="tabular-nums text-default">
            {{ digestLoaded ? digest.total : '–' }} 条
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted">
            收藏
          </dt>
          <dd class="tabular-nums text-default">
            {{ digestLoaded ? digest.saved : '–' }} 条
          </dd>
        </div>
        <!--
          「待读」是这栏唯一能点的地方，也是它从「看数字」变成「能用」的那一步：
          收藏了但没读的就是一份现成的待读队列。0 时不给链接（点进去是空的）。
        -->
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted">
            待读
          </dt>
          <dd class="tabular-nums text-default">
            <ULink
              v-if="digestLoaded && digest.savedUnread > 0"
              to="/saved"
              class="font-medium text-primary hover:underline"
            >
              {{ digest.savedUnread }} 条
            </ULink>
            <template v-else>
              {{ digestLoaded ? digest.savedUnread : '–' }} 条
            </template>
          </dd>
        </div>
      </dl>
    </UCard>
  </aside>
</template>
