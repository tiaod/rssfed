<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const route = useRoute()
const toast = useToast()

const open = ref(false)
const notificationsOpen = ref(false)

const links = [[
// {
//   label: '概览',
//   icon: 'i-lucide-house',
//   to: '/feeds',
//   onSelect: () => {
//     open.value = false
//   }
// }, {
//   label: '订阅源',
//   icon: 'i-lucide-rss',
//   to: '/feeds',
//   onSelect: () => {
//     open.value = false
//   }
// }, {
//   label: '分类',
//   icon: 'i-lucide-folder',
//   to: '/categories',
//   onSelect: () => {
//     open.value = false
//   }
// }, {
//   label: '文章',
//   icon: 'i-lucide-file-text',
//   to: '/entries',
//   onSelect: () => {
//     open.value = false
//   }
// }, {
//   label: 'Miniflux',
//   icon: 'i-lucide-external-link',
//   to: 'https://miniflux.app',
//   target: '_blank',
//   onSelect: () => {
//     open.value = false
//   }
// }, {
//   label: '设置',
//   to: '/settings',
//   icon: 'i-lucide-settings',
//   defaultOpen: true,
//   type: 'trigger',
//   children: [{
//     label: '通用',
//     to: '/settings/general',
//     onSelect: () => {
//       open.value = false
//     }
//   }, {
//     label: '成员',
//     to: '/settings/members',
//     onSelect: () => {
//       open.value = false
//     }
//   }, {
//     label: '通知',
//     to: '/settings/notifications',
//     onSelect: () => {
//       open.value = false
//     }
//   }, {
//     label: '安全',
//     to: '/settings/security',
//     onSelect: () => {
//       open.value = false
//     }
//   }]
// }
  {
    label: '用户管理',
    icon: 'i-lucide-users',
    to: '/admin/users',
    onSelect: () => {
      open.value = false
    }
  }], [{
  label: '反馈',
  icon: 'i-lucide-message-circle',
  to: 'https://github.com',
  target: '_blank'
}, {
  label: '文档',
  icon: 'i-lucide-book-open',
  to: 'https://github.com',
  target: '_blank'
}]] satisfies NavigationMenuItem[][]

const groups = computed(() => [{
  id: 'links',
  label: 'Go to',
  items: links.flat()
}, {
  id: 'code',
  label: 'Code',
  items: [{
    id: 'source',
    label: 'View page source',
    icon: 'i-simple-icons-github',
    to: `https://github.com/nuxt-ui-templates/dashboard/blob/main/app/pages${route.path === '/' ? '/index' : route.path}.vue`,
    target: '_blank'
  }]
}])

onMounted(async () => {
  const cookie = useCookie('cookie-consent')
  if (cookie.value === 'accepted') {
    return
  }

  toast.add({
    title: 'We use first-party cookies to enhance your experience on our website.',
    duration: 0,
    close: false,
    actions: [{
      label: 'Accept',
      color: 'neutral',
      variant: 'outline',
      onClick: () => {
        cookie.value = 'accepted'
      }
    }, {
      label: 'Opt out',
      color: 'neutral',
      variant: 'ghost'
    }]
  })
})
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="open"
      collapsible
      resizable
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <AppLogo :class="collapsed ? 'w-8 h-8' : 'w-28 h-8'" />
      </template>

      <template #default="{ collapsed }">
        <UDashboardSearchButton
          :collapsed="collapsed"
          class="bg-transparent ring-default"
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="links[0]"
          orientation="vertical"
          tooltip
          popover
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="links[1]"
          orientation="vertical"
          tooltip
          class="mt-auto"
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-row gap-2">
          <UTooltip
            text="通知"
            :shortcuts="['N']"
            :disabled="!collapsed"
          >
            <UButton
              color="neutral"
              variant="ghost"
              :class="[
                collapsed ? 'px-0 w-full justify-center' : 'square'
              ]"
              @click="notificationsOpen = !notificationsOpen"
            >
              <UChip
                color="error"
                inset
              >
                <UIcon
                  name="i-lucide-bell"
                  class="size-5 shrink-0"
                />
              </UChip>
            </UButton>
          </UTooltip>
          <UserMenu :collapsed="collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardSearch :groups="groups" />

    <slot />

    <NotificationsSlideover v-model:open="notificationsOpen" />
  </UDashboardGroup>
</template>
