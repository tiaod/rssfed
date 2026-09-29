<script setup lang="ts">
/**
 * 站点配置里的颜色输入：文本框可直接填 hex，左侧色块即触发器，点击弹出取色器。
 *
 * 抽成组件是因为主题色、PWA 主题色、PWA 背景色三处行为完全一致 ——
 * 手动改色、清空恢复默认、色块预览缺一不可，复制三份必然出现其中一处漏改。
 */
const model = defineModel<string>({ default: '' })

const props = withDefaults(defineProps<{
  label: string
  description?: string
  placeholder?: string
  /** 留空时色块与取色器展示的颜色（仅前端展示，不落库） */
  fallbackColor?: string
}>(), {
  description: undefined,
  // 与后端 DEFAULT_THEME_COLOR（app.config.ts 的 primary: 'green' + main.css 的
  // green-500 = #00C16A）保持一致：预览色块和实际生效的默认主题色不能是两个颜色
  placeholder: '#00c16a',
  fallbackColor: '#00c16a'
})

/** UColorPicker 需要具体颜色，空值回退 fallback；选色后写回模型（仍可清空以恢复默认） */
const pickerColor = computed({
  get: () => model.value || props.fallbackColor,
  set: (value: string | undefined) => { model.value = value ?? '' }
})
</script>

<template>
  <UFormField
    :label="label"
    :description="description"
  >
    <!-- 整块输入框即触发器：左侧色块显示当前色，点击（或聚焦后回车）弹出取色器 -->
    <UPopover
      :content="{ onOpenAutoFocus: (e: Event) => e.preventDefault() }"
    >
      <div class="w-48">
        <UInput
          v-model="model"
          :placeholder="placeholder"
          class="w-full"
        >
          <template #leading>
            <span
              class="size-3.5 rounded-full ring-1 ring-default"
              :style="{ backgroundColor: pickerColor }"
            />
          </template>
        </UInput>
      </div>

      <template #content>
        <div class="flex flex-col gap-2 p-3">
          <UColorPicker v-model="pickerColor" />

          <UButton
            v-if="model"
            label="恢复默认"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="ghost"
            size="sm"
            block
            @click="model = ''"
          />
        </div>
      </template>
    </UPopover>
  </UFormField>
</template>
