<script setup lang="ts">
import { ref, computed, onMounted, watch, h, resolveComponent } from 'vue'
import { authClient } from '~~/lib/auth-client'
import type { TableColumn } from '@nuxt/ui'

// Nuxt UI 组件自动注册，在渲染函数中使用需要通过 resolveComponent 获取
const UAvatar = resolveComponent('UAvatar')
const UButton = resolveComponent('UButton')
const UBadge = resolveComponent('UBadge')
const UDropdownMenu = resolveComponent('UDropdownMenu')

interface User {
  id: string
  name: string
  email: string
  role?: string
  banned?: boolean | null
  createdAt: Date | string
}

useHead({
  title: '用户管理 - RSSFed'
})

const { data: session } = await authClient.useSession(useFetch)
const isAdmin = computed(() => session.value?.user?.role === 'admin')

const users = ref<User[]>([])
const isLoading = ref(false)
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)

// 定义用户列表列
const columns: TableColumn<User>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => {
      const isSorted = column.getIsSorted()
      return h(UButton, {
        color: 'neutral',
        variant: 'ghost',
        label: '用户',
        icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
        class: '-mx-2.5',
        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
      })
    },
    cell: ({ row }) => {
      const user = row.original
      return h('div', { class: 'flex items-center gap-3' }, [
        h(UAvatar, { name: user.name, size: 'sm' }),
        h('span', { class: 'font-medium' }, user.name)
      ])
    },
    meta: {
      class: {
        th: 'w-[200px]'
      }
    }
  },
  {
    accessorKey: 'email',
    header: ({ column }) => {
      const isSorted = column.getIsSorted()
      return h(UButton, {
        color: 'neutral',
        variant: 'ghost',
        label: '邮箱',
        icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
        class: '-mx-2.5',
        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
      })
    },
    cell: ({ row }) => {
      return h('span', { class: 'text-sm text-muted' }, row.original.email)
    },
    meta: {
      class: {
        th: 'w-[240px]'
      }
    }
  },
  {
    accessorKey: 'role',
    header: ({ column }) => {
      const isSorted = column.getIsSorted()
      return h(UButton, {
        color: 'neutral',
        variant: 'ghost',
        label: '角色',
        icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
        class: '-mx-2.5',
        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
      })
    },
    cell: ({ row }) => {
      const user = row.original
      const items = [
        { label: '普通用户', onSelect: () => handleSetRole(user.id, 'user'), checked: user.role === 'user' },
        { label: '管理员', onSelect: () => handleSetRole(user.id, 'admin'), checked: user.role === 'admin' }
      ]
      return h(UDropdownMenu, { items }, () =>
        h(UButton, {
          color: user.role === 'admin' ? 'primary' : 'neutral',
          variant: 'soft',
          size: 'sm'
        }, () => user.role === 'admin' ? '管理员' : '普通用户')
      )
    },
    meta: {
      class: {
        th: 'w-[100px]'
      }
    }
  },
  {
    accessorKey: 'banned',
    header: ({ column }) => {
      const isSorted = column.getIsSorted()
      return h(UButton, {
        color: 'neutral',
        variant: 'ghost',
        label: '状态',
        icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
        class: '-mx-2.5',
        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
      })
    },
    cell: ({ row }) => {
      const user = row.original
      return h(UBadge, {
        color: user.banned ? 'error' : 'success',
        variant: 'soft'
      }, () => user.banned ? '已禁用' : '正常')
    },
    meta: {
      class: {
        th: 'w-[100px]'
      }
    }
  },
  {
    accessorKey: 'createdAt',
    header: ({ column }) => {
      const isSorted = column.getIsSorted()
      return h(UButton, {
        color: 'neutral',
        variant: 'ghost',
        label: '注册时间',
        icon: isSorted ? (isSorted === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow') : 'i-lucide-arrow-up-down',
        class: '-mx-2.5',
        onClick: () => column.toggleSorting(column.getIsSorted() === 'asc')
      })
    },
    cell: ({ row }) => {
      const date = new Date(row.original.createdAt).toLocaleDateString('zh-CN')
      return h('span', { class: 'text-sm text-muted' }, date)
    },
    meta: {
      class: {
        th: 'w-[120px]'
      }
    }
  },
  {
    id: 'actions',
    enableHiding: false,
    header: () => h('div', { class: 'text-right' }, '操作'),
    cell: ({ row }) => {
      const user = row.original
      const items = [
        {
          label: user.banned ? '解禁用户' : '禁用用户',
          onSelect: () => user.banned ? handleUnbanUser(user.id) : handleBanUser(user.id),
          color: user.banned ? 'success' : 'warning'
        },
        {
          label: '删除用户',
          onSelect: () => handleDeleteUser(user.id),
          color: 'error'
        }
      ]
      return h('div', { class: 'text-right' },
        h(UDropdownMenu, { items }, () =>
          h(UButton, {
            size: 'sm',
            variant: 'ghost',
            icon: 'i-lucide-more-vertical'
          })
        )
      )
    },
    meta: {
      class: {
        th: 'text-right w-[100px]',
        td: 'text-right'
      }
    },
    enableSorting: false
  }
]

const fetchUsers = async () => {
  if (!isAdmin.value) return

  isLoading.value = true
  try {
    const result = await authClient.admin.listUsers({
      query: {
        limit: pageSize.value,
        offset: (currentPage.value - 1) * pageSize.value
      }
    })

    if (result.data) {
      users.value = result.data.users
      total.value = result.data.total
    }
  } catch (error) {
    console.error('获取用户列表失败:', error)
  } finally {
    isLoading.value = false
  }
}

const handlePageChange = (newPage: number) => {
  currentPage.value = newPage
  fetchUsers()
}

const handleBanUser = async (userId: string) => {
  try {
    await authClient.admin.banUser({ userId })
    await fetchUsers()
  } catch (error) {
    console.error('禁用用户失败:', error)
  }
}

const handleUnbanUser = async (userId: string) => {
  try {
    await authClient.admin.unbanUser({ userId })
    await fetchUsers()
  } catch (error) {
    console.error('解禁用户失败:', error)
  }
}

const handleSetRole = async (userId: string, role: 'user' | 'admin') => {
  try {
    await authClient.admin.setRole({ userId, role })
    await fetchUsers()
  } catch (error) {
    console.error('设置角色失败:', error)
  }
}

const handleDeleteUser = async (userId: string) => {
  if (!confirm('确定要删除这个用户吗？此操作不可撤销。')) return

  try {
    await authClient.admin.removeUser({ userId })
    await fetchUsers()
  } catch (error) {
    console.error('删除用户失败:', error)
  }
}

onMounted(() => {
  if (isAdmin.value) {
    fetchUsers()
  }
})

watch(isAdmin, (newVal) => {
  if (newVal) {
    fetchUsers()
  }
})
</script>

<template>
  <UContainer class="py-8">
    <div class="flex items-center justify-between mb-8">
      <h1 class="text-3xl font-bold">用户管理</h1>
    </div>

    <ClientOnly>
      <div v-if="!isAdmin" class="text-center py-12">
        <UIcon name="i-lucide-shield-alert" class="w-16 h-16 mx-auto text-muted mb-4" />
        <p class="text-lg text-muted">您没有权限访问此页面</p>
      </div>

      <div v-else>
        <UTable
          :data="users"
          :columns="columns"
          :loading="isLoading"
        />

        <div v-if="total > pageSize" class="flex items-center justify-between p-4 mt-4 border-t border-muted">
          <p class="text-sm text-muted">
            共 {{ total }} 条记录，第 {{ currentPage }} / {{ Math.ceil(total / pageSize) }} 页
          </p>
          <UPagination
            v-model:page="currentPage"
            :total="total"
            :items-per-page="pageSize"
            @update:page="handlePageChange"
          />
        </div>
      </div>
    </ClientOnly>
  </UContainer>
</template>
