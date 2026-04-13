<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { authClient } from '~~/lib/auth-client'

useHead({
  title: '用户管理 - RSSFed'
})

const { data: session } = await authClient.useSession(useFetch)
const isAdmin = computed(() => session.value?.user?.role === 'admin')

const users = ref<any[]>([])
const isLoading = ref(false)
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)

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
  <div class="container mx-auto px-4 py-8">
    <div class="flex items-center justify-between mb-8">
      <h1 class="text-3xl font-bold">用户管理</h1>
    </div>

    <div v-if="!isAdmin" class="text-center py-12">
      <UIcon name="i-lucide-shield-alert" class="w-16 h-16 mx-auto text-gray-400 mb-4" />
      <p class="text-lg text-gray-600 dark:text-gray-400">您没有权限访问此页面</p>
    </div>

    <div v-else>
      <UCard>
        <div v-if="isLoading" class="text-center py-8">
          <UIcon name="i-lucide-loader-2" class="w-8 h-8 animate-spin mx-auto" />
        </div>

        <div v-else-if="users.length === 0" class="text-center py-8">
          <p class="text-gray-600 dark:text-gray-400">暂无用户数据</p>
        </div>

        <table v-else class="w-full">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700">
              <th class="text-left py-3 px-4">用户</th>
              <th class="text-left py-3 px-4">邮箱</th>
              <th class="text-left py-3 px-4">角色</th>
              <th class="text-left py-3 px-4">状态</th>
              <th class="text-left py-3 px-4">注册时间</th>
              <th class="text-right py-3 px-4">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id" class="border-b border-gray-100 dark:border-gray-800">
              <td class="py-3 px-4">
                <div class="flex items-center gap-3">
                  <UAvatar :name="user.name" size="sm" />
                  <span class="font-medium">{{ user.name }}</span>
                </div>
              </td>
              <td class="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                {{ user.email }}
              </td>
              <td class="py-3 px-4">
                <UDropdownMenu :items="[
                  { label: '普通用户', click: () => handleSetRole(user.id, 'user'), checked: user.role === 'user' },
                  { label: '管理员', click: () => handleSetRole(user.id, 'admin'), checked: user.role === 'admin' }
                ]">
                  <UButton
                    :color="user.role === 'admin' ? 'primary' : 'neutral'"
                    variant="soft"
                    size="sm"
                  >
                    {{ user.role === 'admin' ? '管理员' : '普通用户' }}
                  </UButton>
                </UDropdownMenu>
              </td>
              <td class="py-3 px-4">
                <UBadge :color="user.banned ? 'error' : 'success'" variant="soft">
                  {{ user.banned ? '已禁用' : '正常' }}
                </UBadge>
              </td>
              <td class="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                {{ new Date(user.createdAt).toLocaleDateString('zh-CN') }}
              </td>
              <td class="py-3 px-4 text-right">
                <UDropdownMenu :items="[
                  { label: user.banned ? '解禁用户' : '禁用用户', click: () => user.banned ? handleUnbanUser(user.id) : handleBanUser(user.id), color: user.banned ? 'success' : 'warning' },
                  { label: '删除用户', click: () => handleDeleteUser(user.id), color: 'error' }
                ]">
                  <UButton size="sm" variant="ghost" icon="i-lucide-more-vertical" />
                </UDropdownMenu>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="total > pageSize" class="flex items-center justify-between mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            共 {{ total }} 条记录，第 {{ currentPage }} / {{ Math.ceil(total / pageSize) }} 页
          </p>
          <div class="flex gap-2">
            <UButton
              size="sm"
              :disabled="currentPage <= 1"
              @click="currentPage--; fetchUsers()"
            >
              上一页
            </UButton>
            <UButton
              size="sm"
              :disabled="currentPage >= Math.ceil(total / pageSize)"
              @click="currentPage++; fetchUsers()"
            >
              下一页
            </UButton>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
