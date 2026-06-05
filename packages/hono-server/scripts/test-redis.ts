import 'dotenv/config'
import { Redis } from 'ioredis'

console.log('🚀 测试 Redis 连接...\n')
console.log('REDIS_URL:', process.env.REDIS_URL || 'redis://localhost:6379')

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')

redis.on('connect', () => {
  console.log('✅ Redis 连接成功!\n')
  redis.quit().then(() => process.exit(0))
})

redis.on('error', (error) => {
  console.error('❌ Redis 连接失败:', error.message)
  console.log('\n提示: 如果 Redis 没有运行，你可以:')
  console.log('1. 启动 Redis 服务')
  console.log('2. 或者暂时禁用 Redis secondary storage')
  process.exit(1)
})
