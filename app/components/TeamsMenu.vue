<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const _props = defineProps<{
  collapsed: boolean
}>()

const activeOrg = ref<{ name: string, slug: string }>({
  name: '个人',
  slug: 'personal'
})

const orgs = computed(() => {
  const items: DropdownMenuItem[] = [
    {
      label: '个人',
      icon: 'i-lucide-user',
      onSelect: () => {
        activeOrg.value = { name: '个人', slug: 'personal' }
      }
    }
  ]
  return items
})
</script>

<template>
  <UDropdownMenu :items="[orgs]">
    <UButton
      variant="ghost"
      size="sm"
      :class="collapsed ? 'px-0' : 'w-full justify-start'"
    >
      <div class="flex items-center gap-2">
        <div class="flex size-6 items-center justify-center rounded-md bg-primary text-primary-fg">
          <span class="text-xs font-bold">
            {{ activeOrg.name[0] }}
          </span>
        </div>
        <span
          v-if="!collapsed"
          class="truncate font-medium"
        >
          {{ activeOrg.name }}
        </span>
        <UIcon
          v-if="!collapsed"
          name="i-lucide-chevron-down"
          class="ml-auto size-4 text-muted"
        />
      </div>
    </UButton>
  </UDropdownMenu>
</template>
