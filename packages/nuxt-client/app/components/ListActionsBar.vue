<script setup lang="ts">
/**
 * 列表页右上角的动作区：**全部标记为已读按钮 + 「三个点」菜单**。
 *
 * 两者放同一个组件是有意的：同步状态（转圈 / 失败）要同时体现在「标记已读」按钮上，
 * 而状态来自 `useManualSync`，每个实例各持一份 —— 分成两个组件就会出现「菜单里点了同步、
 * 外面的指示按钮不动」。
 *
 * 布局：〔切换视图〕〔只看未读〕〔✓ 全部标记为已读〕〔⋮ 页面动作〕。
 * 视图切换不在这里（见 ListViewSwitcher），「只看未读」的开关状态由页面持有（见 useUnreadFilter），
 * 这里只负责把它渲染成一个可点的开关：开着时高亮 + aria-pressed，页面据此过滤列表。
 *
 * 「标记为已读」按钮：
 *   点击 → 就地在按钮旁弹出确认浮层（一次批量写、没有「全部撤销」，值得多一步），确认后才抛事件；
 *   同步中 → 转圈并禁用（正在写库，这时候也不该去标记）；
 *   同步失败 → 变红 + 警告图标，错误详情同时出现在按钮 title 与确认浮层里。
 *
 * 菜单内容按页面能力拼：
 *   时间线 / 分组页   同步订阅
 *   单源页           刷新订阅 + 编辑订阅 ｜ 取消订阅
 *   bot 产出页       刷新订阅 + 编辑订阅 ｜ 订阅 / 取消订阅
 */
import { computed, ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useSyncAction } from '~/composables/useSyncAction'
import type { ManualSyncOutcome } from '~/composables/useManualSync'

const props = withDefaults(defineProps<{
  /** 限定同步范围的库 id；不传 = 所有已激活的库（同步全部订阅） */
  feedIds?: string[]
  /** 同步那一项的文案：单源 / bot 页是「刷新订阅」，聚合页是「同步订阅」 */
  syncLabel?: string
  /** 传了才显示订阅类动作（编辑订阅 / 取消订阅 / 订阅） */
  feedId?: string
  /** 当前列表已加载的条目数（= 会被标记的总数）；0 时按钮不可点。开着「只看未读」时传的是可见条数 */
  entryCount?: number
  /** 是否已订阅（bot 产出页在「订阅 / 取消订阅」之间切换）；不传按已订阅处理 */
  subscribed?: boolean
  /** 「只看未读」是否开启（状态由页面持有，这里只渲染开关） */
  unreadOnly?: boolean
}>(), {
  feedIds: undefined,
  syncLabel: '同步订阅',
  feedId: undefined,
  entryCount: 0,
  subscribed: true,
  unreadOnly: false
})

const emit = defineEmits<{
  'synced': [outcome: ManualSyncOutcome]
  'mark-all-read': []
  'toggle-unread-only': []
  'edit': []
  'subscribe': []
  'unsubscribe': []
}>()

const { syncing, hasError, errorDetail, statusText, sync } = useSyncAction(() => props.feedIds)

async function handleSync() {
  const outcome = await sync()
  // 空转（上一轮还在跑）不发事件，与 SyncButton 一致
  if (outcome) emit('synced', outcome)
}

/** 确认浮层的开关：确认之后才真正抛事件 */
const confirmOpen = ref(false)

/** 同步中不能标记：一堆写入还在落盘，标完的状态可能立刻又被同步改动覆盖 */
const markAllReadDisabled = computed(() => props.entryCount === 0 || syncing.value)

const markAllReadTooltip = computed(() => {
  if (syncing.value) return '同步中…同步结束后可以标记为已读'
  if (hasError.value) return `同步失败：${errorDetail.value}`
  if (props.entryCount === 0) {
    return props.unreadOnly ? '当前没有未读条目' : '当前列表没有条目'
  }
  return props.unreadOnly ? '把未读条目全部标记为已读' : '全部标记为已读'
})

function confirmMarkAllRead() {
  confirmOpen.value = false
  emit('mark-all-read')
}

const items = computed<DropdownMenuItem[][]>(() => {
  const actions: DropdownMenuItem[] = [
    {
      label: syncing.value ? '同步中…' : props.syncLabel,
      description: statusText.value ?? undefined,
      icon: 'i-lucide-refresh-cw',
      disabled: syncing.value,
      onSelect: () => { void handleSync() }
    }
  ]

  if (props.feedId) {
    actions.push({
      label: '编辑订阅',
      icon: 'i-lucide-pencil',
      onSelect: () => emit('edit')
    })
  }

  const groups: DropdownMenuItem[][] = [actions]

  if (props.feedId) {
    groups.push([
      props.subscribed
        ? {
            label: '取消订阅',
            icon: 'i-lucide-bell-off',
            color: 'error',
            onSelect: () => emit('unsubscribe')
          }
        : {
            label: '订阅',
            icon: 'i-lucide-bell-plus',
            color: 'primary',
            onSelect: () => emit('subscribe')
          }
    ])
  }

  return groups
})
</script>

<template>
  <div class="flex items-center gap-1.5">
    <!-- 「只看未读」开关：纯客户端过滤已加载的条目（见 useUnreadFilter），与同步状态无关 -->
    <UButton
      icon="i-lucide-circle-dot"
      :color="unreadOnly ? 'primary' : 'neutral'"
      :variant="unreadOnly ? 'soft' : 'ghost'"
      :aria-pressed="unreadOnly"
      :title="unreadOnly ? '只看未读：已开启，点击显示全部' : '只看未读'"
      aria-label="只看未读"
      size="sm"
      @click="emit('toggle-unread-only')"
    />

    <UPopover
      v-model:open="confirmOpen"
      :content="{ align: 'end', sideOffset: 8 }"
    >
      <UButton
        :icon="hasError ? 'i-lucide-alert-circle' : 'i-lucide-circle-check'"
        :loading="syncing"
        :color="hasError ? 'error' : 'neutral'"
        :disabled="markAllReadDisabled"
        :title="markAllReadTooltip"
        variant="ghost"
        size="sm"
        aria-label="全部标记为已读"
      />

      <template #content>
        <div class="w-60 p-3">
          <p class="text-sm text-highlighted">
            把当前列表的 {{ entryCount }} 条标记为已读？
          </p>
          <p class="mt-1 text-xs text-muted">
            只处理已经加载出来的条目
          </p>
          <p
            v-if="hasError"
            class="mt-2 text-xs text-error"
          >
            同步失败：{{ errorDetail }}
          </p>

          <div class="mt-3 flex justify-end gap-2">
            <UButton
              variant="outline"
              color="neutral"
              size="sm"
              @click="confirmOpen = false"
            >
              取消
            </UButton>
            <UButton
              color="error"
              size="sm"
              icon="i-lucide-circle-check"
              @click="confirmMarkAllRead"
            >
              全部标记为已读
            </UButton>
          </div>
        </div>
      </template>
    </UPopover>

    <UDropdownMenu
      :items="items"
      :content="{ align: 'end' }"
    >
      <UButton
        icon="i-lucide-ellipsis-vertical"
        title="更多操作"
        aria-label="更多操作"
        variant="ghost"
        color="neutral"
        size="sm"
      />
    </UDropdownMenu>
  </div>
</template>
