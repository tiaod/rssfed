import 'dotenv/config'
import { auth } from '../app/lib/auth'

interface TestUser {
  email: string
  name: string
  password: string
  role?: string
}

// 要创建的测试用户总数
const TOTAL_TEST_USERS = 200

// 生成测试用户数组
function generateTestUsers(): TestUser[] {
  const users: TestUser[] = [
    // 保留管理员账号
    {
      email: 'admin@example.com',
      name: '管理员',
      password: 'Admin123!',
      role: 'admin',
    },
  ]

  // 生成 N 个测试用户
  for (let i = 1; i <= TOTAL_TEST_USERS - 1; i++) {
    users.push({
      email: `user${i}@test.com`,
      name: `测试用户 ${i}`,
      password: 'Password123!',
      role: 'user',
    })
  }

  return users
}

async function main() {
  const testUsers = generateTestUsers()
  console.log(`🚀 开始创建 ${testUsers.length} 个测试用户...\n`)

  let successCount = 0
  let existsCount = 0
  let errorCount = 0

  for (const testUser of testUsers) {
    try {
      const result = await auth.api.createUser({
        body: {
          email: testUser.email,
          name: testUser.name,
          password: testUser.password,
          emailVerified: true,
          role: testUser.role || 'user',
        },
      })

      if (result.error) {
        console.log(`⚠️  用户已存在或创建失败: ${testUser.email}`)
        existsCount++
      } else {
        if (successCount < 10 || successCount === testUsers.length - 1) {
          console.log(`✅ 用户创建成功: ${testUser.email}`)
        } else if (successCount % 20 === 0) {
          console.log(`... 已创建 ${successCount} 个用户`)
        }
        successCount++
      }
    } catch (error) {
      console.error(`❌ 创建用户时发生错误: ${testUser.email}`, error)
      errorCount++
    }
  }

  console.log('\n🎯 创建完成!')
  console.log(`   ✅ 成功: ${successCount}`)
  console.log(`   ⚠️  已存在/跳过: ${existsCount}`)
  console.log(`   ❌ 失败: ${errorCount}`)
  console.log(`   📊 总计: ${testUsers.length}`)

  process.exit(0)
}

main().catch((error) => {
  console.error('❌ 执行失败:', error)
  process.exit(1)
})
