#!/usr/bin/env node
import { randomBytes } from 'crypto'
import { appendFile } from 'fs/promises'

function generateHex(length: number): string {
  return randomBytes(length).toString('hex')
}

function generateBase64(length: number): string {
  return randomBytes(length).toString('base64')
}

async function main() {
  const keys = [
    `GARAGE_RPC_SECRET=${generateHex(32)}`,
    `GARAGE_ADMIN_TOKEN=${generateBase64(32)}`,
    `GARAGE_DEFAULT_ACCESS_KEY=GK${generateHex(16)}`,
    `GARAGE_DEFAULT_SECRET_KEY=${generateHex(32)}`,
    `GARAGE_DEFAULT_BUCKET=rssfed`,
    '',
    '# S3 存储客户端配置',
    'STORAGE_S3_ENDPOINT=http://localhost:3900',
    'STORAGE_S3_REGION=garage',
    'STORAGE_S3_ACCESS_KEY_ID=$GARAGE_DEFAULT_ACCESS_KEY',
    'STORAGE_S3_SECRET_ACCESS_KEY=$GARAGE_DEFAULT_SECRET_KEY',
    'STORAGE_S3_BUCKET=$GARAGE_DEFAULT_BUCKET',
    'STORAGE_S3_PUBLIC_DOMAIN=',
    'STORAGE_S3_PATH_PREFIX=',
    'STORAGE_S3_FORCE_PATH_STYLE=true',
    ''
  ].join('\n')

  console.log('Generating Garage keys and appending to .env...')
  await appendFile('.env', '\n' + keys)
  console.log('✅ Done! Keys have been appended to .env')
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})
