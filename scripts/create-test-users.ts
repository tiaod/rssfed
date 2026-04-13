import 'dotenv/config'
import { auth } from '../lib/auth'

interface TestUser {
  email: string
  name: string
  password: string
  role?: string
}

const testUsers: TestUser[] = [
  {
    email: 'admin@example.com',
    name: '管理员',
    password: 'Admin123!',
    role: 'admin',
  },
  {
    email: 'test1@example.com',
    name: '测试用户1',
    password: 'Test123!',
  },
  {
    email: 'test2@example.com',
    name: '测试用户2',
    password: 'Test123!',
  },
]

async function main() {
  console.log('🚀 开始创建测试用户...\n')
  
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
        console.log(`   错误: ${result.error.message}`)
      } else {
        console.log(`✅ 用户创建成功: ${testUser.email}`)
        console.log(`   密码: ${testUser.password}`)
        console.log(`   用户ID: ${result.data?.user.id}`)
      }
    } catch (error) {
      console.error(`❌ 创建用户时发生错误: ${testUser.email}`, error)
    }
    console.log()
  }
  
  console.log('🎉 测试用户创建完成!')
  process.exit(0)
}

main().catch((error) => {
  console.error('❌ 执行失败:', error)
  process.exit(1)
})
