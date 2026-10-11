import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import EditSubscriptionModal from '../../components/settings/EditSubscriptionModal.vue'
import type { EditableSubscription } from '../../components/settings/EditSubscriptionModal.vue'

/**
 * 编辑订阅弹窗：名字 / 分类 / 默认视图可改，**订阅源地址只读**。
 *
 * 盯三件事：地址拿得到时以禁用输入框展示（feed 是抓取地址、bot 是联邦地址），
 * 拿不到时整行不出现；复制成功的反馈做在按钮自己身上（图标换 √）而不是弹通知；
 * 以及保存只写名字 / 分类 / 默认视图 —— 地址永远不进补丁。
 */

const testGlobals = globalThis as unknown as Record<string, unknown>

const H = vi.hoisted(() => ({
  updateSubscription: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
  /** vueuse 的 copied：复制成功后置位、到点自己收回（组件只读它） */
  copied: null as { value: boolean } | null
}))

// 剪贴板：happy-dom 里没有真实实现，只关心组件拿 copy 与 copied 做什么
vi.mock('@vueuse/core', async () => {
  const { ref } = await import('vue')
  return {
    useClipboard: () => ({
      copy: H.copy,
      copied: (H.copied ??= ref(false) as unknown as { value: boolean })
    })
  }
})

testGlobals.usePouchDb = () => ({ updateSubscription: H.updateSubscription })

const toastAdd = vi.fn()
testGlobals.useToast = () => ({ add: toastAdd })

beforeEach(() => {
  H.updateSubscription.mockReset()
  H.updateSubscription.mockResolvedValue(undefined)
  H.copied = null
  H.copy.mockReset()
  // 与真实实现一致：复制成功时把 copied 置位
  H.copy.mockImplementation(async () => {
    if (H.copied) {
      H.copied.value = true
    }
  })
  toastAdd.mockReset()
})

/** 地址行：字段标签 + 值都要能定位到 */
function fieldByLabel(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('.uformfield').find(f => f.find('.label').text() === label)
}

function copyButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('button[aria-label="复制订阅源地址"]')
}

function saveButton(wrapper: ReturnType<typeof mount>) {
  const hit = wrapper.findAll('button').find(b => b.text() === '保存')
  if (!hit) throw new Error('弹窗里没有保存按钮')
  return hit
}

const STUBS = {
  UModal: {
    name: 'UModal',
    props: ['open', 'title', 'ui'],
    template: '<div class="umodal"><slot name="body" /><slot name="footer" /></div>'
  },
  UForm: {
    name: 'UForm',
    emits: ['submit'],
    template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>'
  },
  UFormField: {
    name: 'UFormField',
    props: ['label', 'description', 'hint'],
    template: '<div class="uformfield"><span class="label">{{ label }}</span><span class="desc">{{ description }}</span><slot /></div>'
  },
  UInput: {
    name: 'UInput',
    props: ['modelValue', 'placeholder', 'readonly', 'disabled', 'trailing', 'ui', 'title'],
    emits: ['update:modelValue'],
    template: '<div class="uinput"><input :value="modelValue" :readonly="readonly" :disabled="disabled" :placeholder="placeholder" :title="title" @input="$emit(\'update:modelValue\', $event.target.value)"><slot name="trailing" /></div>'
  },
  UTooltip: {
    name: 'UTooltip',
    props: ['text', 'content'],
    template: '<span class="utooltip" :data-text="text"><slot /></span>'
  },
  USelect: {
    name: 'USelect',
    props: ['modelValue', 'items', 'valueKey'],
    emits: ['update:modelValue'],
    template: '<select class="uselect"><option v-for="i in items" :key="i.value" :value="i.value">{{ i.label }}</option></select>'
  },
  UAlert: {
    name: 'UAlert',
    props: ['color', 'variant', 'title', 'icon'],
    template: '<div class="ualert">{{ title }}</div>'
  },
  UButton: {
    name: 'UButton',
    props: ['icon', 'label', 'color', 'variant', 'size', 'loading', 'ariaLabel'],
    emits: ['click'],
    template: '<button class="ubtn" :aria-label="ariaLabel" :data-icon="icon" :data-color="color" :data-variant="variant" @click="$emit(\'click\')"><slot>{{ label }}</slot></button>'
  }
}

function mountModal(subscription: EditableSubscription | null) {
  return mount(EditSubscriptionModal, { props: { subscription }, global: { stubs: STUBS } })
}

describe('EditSubscriptionModal 订阅源地址（只读）', () => {
  it('feed 订阅：地址放在禁用输入框里，用户改不了', () => {
    const wrapper = mountModal({
      feedId: 'feed-1',
      title: '腾讯云开发者',
      category: '技术团队与博客',
      feedUrl: 'https://example.com/feed.xml'
    })

    const field = fieldByLabel(wrapper, '订阅源地址')
    expect(field).toBeTruthy()

    const input = field!.find('input')
    expect(input.element.value).toBe('https://example.com/feed.xml')
    expect(input.attributes('disabled')).toBeDefined()
    // 悬停能看全（单行框装不下长地址）
    expect(input.attributes('title')).toBe('https://example.com/feed.xml')
  })

  it('bot 订阅：同一位显示联邦地址', () => {
    const wrapper = mountModal({ feedId: 'bot:42', title: '验证机器人', feedUrl: '@alice@rss.example.com' })

    expect(fieldByLabel(wrapper, '订阅源地址')!.find('input').element.value).toBe('@alice@rss.example.com')
  })

  it('取不到地址（离线 / 未订阅）：整行不渲染，其余字段照常', () => {
    const wrapper = mountModal({ feedId: 'bot:42', title: '验证机器人' })

    expect(fieldByLabel(wrapper, '订阅源地址')).toBeUndefined()
    expect(fieldByLabel(wrapper, '显示名称')).toBeTruthy()
  })

  it('点复制按钮亮 √（不弹通知），vueuse 收回 copied 后图标复原', async () => {
    const wrapper = mountModal({ feedId: 'feed-1', title: '源', feedUrl: 'https://example.com/feed.xml' })
    expect(copyButton(wrapper).attributes('data-icon')).toBe('i-lucide-copy')

    await copyButton(wrapper).trigger('click')
    await flushPromises()
    await nextTick()

    expect(H.copy).toHaveBeenCalledWith('https://example.com/feed.xml')
    const done = wrapper.get('button[aria-label="已复制订阅源地址"]')
    expect(done.attributes('data-icon')).toBe('i-lucide-copy-check')
    expect(done.attributes('data-color')).toBe('success')
    // 轻提示就够了：不弹右下角通知
    expect(toastAdd).not.toHaveBeenCalled()

    // vueuse 到点把 copied 收回（copiedDuring），图标与配色跟着复原
    H.copied!.value = false
    await nextTick()
    expect(copyButton(wrapper).attributes('data-icon')).toBe('i-lucide-copy')
    expect(copyButton(wrapper).attributes('data-color')).toBe('neutral')
  })

  it('复制没成功（copied 没置位）：保持复制图标，也不弹通知', async () => {
    H.copy.mockImplementation(async () => {})
    const wrapper = mountModal({ feedId: 'feed-1', title: '源', feedUrl: 'https://example.com/feed.xml' })

    await copyButton(wrapper).trigger('click')
    await flushPromises()
    await nextTick()

    expect(copyButton(wrapper).attributes('data-icon')).toBe('i-lucide-copy')
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it('保存只写名字 / 分类 / 默认视图，地址不进补丁', async () => {
    const wrapper = mountModal({
      feedId: 'feed-1',
      title: '旧名字',
      category: '技术团队与博客',
      feedUrl: 'https://example.com/feed.xml'
    })

    await wrapper.findAll('.uinput input')[0]!.setValue('新名字')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(H.updateSubscription).toHaveBeenCalledTimes(1)
    const [feedId, patch] = H.updateSubscription.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(feedId).toBe('feed-1')
    expect(Object.keys(patch).sort()).toEqual(['category', 'title', 'view'])
    expect(patch.title).toBe('新名字')
    expect(patch).not.toHaveProperty('feedUrl')
  })
})
