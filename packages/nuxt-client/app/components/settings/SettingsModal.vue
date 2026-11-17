<script setup lang="ts">
/**
 * 设置弹窗：宽屏是「左侧分区导航 + 右侧内容」，窄屏是「分区列表 → 分区详情」两级。
 *
 * 设置从「独立页面 + 标签页」改成弹窗，是因为打开设置时用户通常正读到一半：
 * 原先跳到 /profile 会丢掉列表与滚动位置（宽屏下连右侧阅读栏都会关掉）。
 *
 * 窄屏为什么不做成顶部横排标签：分区只有三个但每个标签都带图标和文字，一行放不下要横滑；
 * 而分区本身的说明很长（常规分区一屏放不下四张卡），横滑条再压掉一行高度后，用户既看不全
 * 分区又看不好内容。改成两级后每屏只承担一件事，返回键位置也符合手机上的预期。
 * 用 `sm` 断点与 aside 的 `hidden sm:flex` 成对，判定完全交给 CSS，不需要读窗口宽度
 * （SSR 首帧与客户端就不会不一致）。
 *
 * 弹窗只负责外壳与分区切换；各分区自己的状态（草稿、加载、确认弹窗）留在各自组件里，
 * 于是关掉弹窗时它们一起卸载 —— 草稿自然丢弃，下次打开总是已保存的值。
 *
 * 布局用自定义 `content` 槽位而不是 UModal 默认的 header / body / footer：
 * 默认版式是「标题在上、正文在下」，做不出左侧导航这一栏。传 `title` 是为了让
 * reka 的 DialogTitle 拿到可访问名（Nuxt UI 在 content 槽位下会把它放进 VisuallyHidden）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import SettingsGeneralSection from '~/components/settings/SettingsGeneralSection.vue'
import SettingsDataSection from '~/components/settings/SettingsDataSection.vue'
import SettingsNav from '~/components/settings/SettingsNav.vue'
import McpSetupPanel from '~/components/settings/McpSetupPanel.vue'
import {
  SETTINGS_SECTIONS,
  useSettingsModal,
  type SettingsSection
} from '~/composables/useSettingsModal'

const { isOpen, section, pane } = useSettingsModal()

const current = computed(
  () => SETTINGS_SECTIONS.find(item => item.value === section.value) ?? SETTINGS_SECTIONS[0]!
)

/**
 * 内容区的滚动容器。
 *
 * 切换分区时必须把滚动位置归零：容器是同一个 DOM 节点，浏览器会保留 scrollTop，
 * 从「数据」（滚到很下面）切到「AI 助手」时，新分区一进来就已经被滚掉一截 ——
 * 看起来就像首屏卡片的上边框被吃掉。
 */
const scrollEl = ref<HTMLElement | null>(null)

watch([section, isOpen, pane], async () => {
  await nextTick()
  scrollEl.value?.scrollTo({ top: 0 })
})

/** 移动端列表里点一行：落到该分区。宽屏没有这一步，直接切换右侧内容 */
function openSection(next: SettingsSection): void {
  section.value = next
  pane.value = 'section'
}

/**
 * 弹窗尺寸：宽到能放下「说明在左、控件在右」的双栏，高到不超过视口。
 *
 * 用 sm:max-w-* 断点变体覆盖 UModal 的基础 max-w-lg（同一属性后写生效），
 * 比直接写 max-w 更稳。高度用 dvh，手机上不会被地址栏顶掉一截。
 *
 * 关掉内置的关闭按钮（`:close="false"`）：它的落点是「内容右上角」，而这里的右上角
 * 属于内容区的滚动条轨道，按钮会盖在滚动条上；标题行自己放一个更合适。
 */
const modalUi = {
  content: 'w-[calc(100vw-2rem)] sm:max-w-5xl h-[min(88dvh,48rem)] flex flex-col overflow-hidden',
  // 内容槽自己管内边距与滚动，默认的 body 内边距必须清掉（合并语义，只写 p-0 不够）
  body: 'p-0 sm:p-0'
}

/**
 * 订阅管理入口（导航末尾，带一个外链样式的小图标）。
 *
 * 它不是设置分区：不切换右侧内容，点一下就离开弹窗去整页 —— 订阅列表长、整理时还要
 * 来回开编辑弹窗，塞不进这个弹窗。因此图标走 trailing 位、独立于上面的分区按钮。
 *
 * 必须显式先关弹窗：弹窗挂在 default 布局上（不在页面里），跳页不会卸载它，
 * 不关的话新页面上会继续盖着一层设置。
 */
async function openSubscriptions(closeModal: () => void): Promise<void> {
  closeModal()
  await navigateTo('/subscriptions')
}
</script>

<template>
  <UModal
    v-model:open="isOpen"
    title="设置"
    :close="false"
    :ui="modalUi"
  >
    <template #content="{ close: closeModal }">
      <div class="flex min-h-0 flex-1">
        <!-- 左侧分区导航：窄屏收起，改为「分区列表 → 分区详情」两级（见下方 sm:hidden 的两块） -->
        <aside
          class="hidden w-56 shrink-0 flex-col border-e border-default p-3 sm:flex"
        >
          <p class="px-2 pb-2 pt-1 text-lg font-semibold text-highlighted">
            设置
          </p>
          <SettingsNav
            :active="section"
            @select="section = $event"
            @subscriptions="openSubscriptions(closeModal)"
          />
        </aside>

        <!--
          窄屏第一级：与宽屏竖栏同一个 SettingsNav，不另做一套视觉 ——
          同一个弹窗在两种宽度下应当看起来是同一个东西。
          这里只负责外壳（标题行 + 可滚动区）与「点了去哪」。
        -->
        <div
          v-if="pane === 'menu'"
          class="flex min-h-0 flex-1 flex-col sm:hidden"
        >
          <header class="flex shrink-0 items-center gap-2 px-5 py-3">
            <h2 class="text-base font-semibold text-highlighted">
              设置
            </h2>
            <UButton
              class="ms-auto"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="关闭设置"
              @click="closeModal()"
            />
          </header>

          <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
            <SettingsNav
              :active="section"
              @select="openSection"
              @subscriptions="openSubscriptions(closeModal)"
            />
          </nav>
        </div>

        <!--
          分区详情：宽屏常驻（与 aside 并排）；窄屏只在 pane === 'section' 出现。
          用 CSS 判宽屏而不是读窗口宽度，SSR 首帧与客户端因此不会不一致。
        -->
        <div
          class="min-h-0 min-w-0 flex-1 flex-col"
          :class="pane === 'menu' ? 'hidden sm:flex' : 'flex'"
        >
          <header class="flex shrink-0 items-center gap-2 px-5 py-3 sm:px-6">
            <!-- 返回上一级：只在窄屏出现，宽屏没有「上一级」（分区列表一直在左边） -->
            <UButton
              v-if="pane === 'section'"
              class="-ms-1 sm:hidden"
              icon="i-lucide-arrow-left"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="返回设置列表"
              @click="pane = 'menu'"
            />
            <h2 class="text-base font-semibold text-highlighted">
              {{ current.label }}
            </h2>
            <UButton
              class="ms-auto"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="关闭设置"
              @click="closeModal()"
            />
          </header>

          <!--
            顶部留出 pt-2：滚动容器本身会裁掉溢出内容，第一张卡片若贴着容器上沿，
            它的圆角上边框正好压在裁切线上（看起来像边框被吃掉）。pb 同理。
          -->
          <div
            ref="scrollEl"
            class="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2 sm:px-6"
          >
            <SettingsGeneralSection v-if="section === 'general'" />
            <McpSetupPanel v-else-if="section === 'ai'" />
            <SettingsDataSection v-else-if="section === 'data'" />
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
