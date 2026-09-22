<script setup lang="ts">
const api = useApi()
const toast = useToast()
const siteSettings = useSiteSettings()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

/** 表单草稿：logo 单独即时保存，其余字段点「保存」统一提交 */
const form = ref({
  siteTitle: '',
  description: '',
  primaryColor: '',
  skin: ''
})
const logoUrl = ref<string | null>(null)

const logoInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }, message?: string }
  return err.data?.error ?? err.message ?? '未知错误'
}

/** 空串视为「恢复默认」，后端以 null 落库 */
function toNullable(v: string) {
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

/** 主题色留空时，取色器与色块用于展示的内置默认色（仅前端展示，不落库） */
const DEFAULT_PRIMARY_COLOR = '#059669'

/** UColorPicker 需要具体颜色，空值回退默认色；选色后写回表单（仍可手动清空以恢复默认） */
const pickerColor = computed({
  get: () => form.value.primaryColor || DEFAULT_PRIMARY_COLOR,
  set: (value: string | undefined) => { form.value.primaryColor = value ?? '' }
})

async function load() {
  loading.value = true
  error.value = null
  try {
    const s = await api.admin.siteSettings.get()
    form.value = {
      siteTitle: s.siteTitle ?? '',
      description: s.description ?? '',
      primaryColor: s.primaryColor ?? '',
      skin: s.skin ?? ''
    }
    logoUrl.value = s.logoUrl ?? null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await api.admin.siteSettings.update({
      siteTitle: toNullable(form.value.siteTitle),
      description: toNullable(form.value.description),
      primaryColor: toNullable(form.value.primaryColor)?.toLowerCase() ?? null,
      skin: toNullable(form.value.skin)
    })
    toast.add({ title: '站点设置已保存', color: 'success' })
    void siteSettings.refresh()
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

/** 选择文件后立即上传（S3 + attachments），无需等「保存」 */
async function handleLogoChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  try {
    const r = await api.admin.siteSettings.uploadLogo(file)
    logoUrl.value = r.logoUrl
    toast.add({ title: 'Logo 已更新', color: 'success' })
    void siteSettings.refresh()
  } catch (err) {
    toast.add({ title: '上传失败', description: errorMessage(err), color: 'error' })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function removeLogo() {
  try {
    await api.admin.siteSettings.deleteLogo()
    logoUrl.value = null
    toast.add({ title: '已恢复默认 Logo', color: 'success' })
    void siteSettings.refresh()
  } catch (err) {
    toast.add({ title: '删除失败', description: errorMessage(err), color: 'error' })
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      title="加载失败"
      icon="i-lucide-circle-alert"
    >
      <template #description>
        {{ error }}
      </template>
      <template #actions>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          @click="load"
        >
          重试
        </UButton>
      </template>
    </UAlert>

    <template v-else-if="loading">
      <USkeleton class="h-32 w-full rounded-xl" />
      <USkeleton class="h-32 w-full rounded-xl" />
    </template>

    <template v-else>
      <!-- Logo -->
      <UFormField
        label="站点 Logo"
        description="上传后在站点各处展示站长设定的图形（离线时由 Service Worker 缓存可用）"
      >
        <div class="flex items-center gap-3">
          <UAvatar
            v-if="logoUrl"
            :src="logoUrl"
            alt="站点 Logo"
            size="xl"
          />
          <UAvatar
            v-else
            text="R"
            size="xl"
            color="primary"
          />
          <div class="flex flex-col gap-2 sm:flex-row">
            <UButton
              icon="i-lucide-upload"
              variant="outline"
              :loading="uploading"
              @click="logoInput?.click()"
            >
              上传
            </UButton>
            <input
              ref="logoInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleLogoChange"
            >
            <UButton
              v-if="logoUrl"
              icon="i-lucide-trash"
              variant="ghost"
              color="error"
              @click="removeLogo"
            >
              移除
            </UButton>
          </div>
        </div>
      </UFormField>

      <!-- 品牌 -->
      <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
        品牌
      </h3>

      <UFormField label="站点标题">
        <UInput
          v-model="form.siteTitle"
          class="w-full"
          placeholder="RSSFed"
        />
      </UFormField>

      <UFormField label="描述">
        <UTextarea
          v-model="form.description"
          class="w-full"
          :rows="2"
          placeholder="一句话介绍当前站点"
        />
      </UFormField>

      <!-- 外观 -->
      <h3 class="text-sm font-semibold text-muted uppercase tracking-wide">
        外观
      </h3>

      <UFormField
        label="主题色"
        description="主色调（hex）。留空使用应用内置默认主题"
      >
        <!-- 整块输入框即触发器：左侧色块显示当前色，点击（或聚焦后回车）弹出取色器 -->
        <UPopover
          :content="{ onOpenAutoFocus: (e: Event) => e.preventDefault() }"
        >
          <div class="w-48">
            <UInput
              v-model="form.primaryColor"
              placeholder="#059669"
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
              <UColorPicker
                v-model="pickerColor"
              />

              <UButton
                v-if="form.primaryColor"
                label="恢复默认"
                icon="i-lucide-rotate-ccw"
                color="neutral"
                variant="ghost"
                size="sm"
                block
                @click="form.primaryColor = ''"
              />
            </div>
          </template>
        </UPopover>
      </UFormField>

      <UFormField
        label="皮肤"
        description="皮肤标识（占位字段：皮肤体系尚未定义，可先存名字；留空使用默认皮肤）"
      >
        <UInput
          v-model="form.skin"
          class="w-64"
          placeholder="默认"
        />
      </UFormField>

      <div class="flex justify-start">
        <UButton
          color="primary"
          icon="i-lucide-save"
          :loading="saving"
          @click="save"
        >
          保存设置
        </UButton>
      </div>
    </template>
  </div>
</template>
