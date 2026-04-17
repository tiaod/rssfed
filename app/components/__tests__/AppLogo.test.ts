import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AppLogo from '../AppLogo.vue'

describe('AppLogo', () => {
  it('应该能正确渲染', () => {
    const wrapper = mount(AppLogo)
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('svg 应该有正确的尺寸', () => {
    const wrapper = mount(AppLogo)
    const svg = wrapper.find('svg')
    expect(svg.attributes('width')).toBe('1020')
    expect(svg.attributes('height')).toBe('200')
  })
})
