export interface SubscriptionItem {
  id: string // feedId
  title: string
  siteUrl?: string
  description?: string
  image?: string
  category?: string
  createdAt: string
}

/**
 * 通过 Hono 代理直连 CouchDB 用户状态库。
 * 走 /api/couchdb/proxy/user-state/*，Hono 自动 Proxy Auth 签名。
 */
export function useCouchDb() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  const base = apiBaseUrl.replace(/\/+$/, '')
  const proxyBase = `${base}/api/couchdb/proxy/user-state`

  /** 获取当前用户库的订阅列表（Mango 查询） */
  async function listSubscriptions(): Promise<SubscriptionItem[]> {
    const res = await fetch(`${proxyBase}/_find`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selector: { type: 'subscription' },
        fields: ['feedId', 'title', 'siteUrl', 'description', 'image', 'category', 'createdAt'],
        limit: 100
      })
    })

    if (!res.ok) {
      if (res.status === 404) return []
      throw new Error(`CouchDB query failed: ${res.statusText}`)
    }

    const data = await res.json()
    return (data.docs ?? []).map((doc: { feedId: string, title: string, siteUrl?: string, description?: string, image?: string, category?: string, createdAt?: string }) => ({
      id: doc.feedId,
      title: doc.title,
      siteUrl: doc.siteUrl,
      description: doc.description,
      image: doc.image,
      category: doc.category ?? undefined,
      createdAt: doc.createdAt
    }))
  }

  /** 添加订阅：先通过 API 获取 FeedDoc 信息，再写入 CouchDB */
  async function addSubscription(feedId: string, category?: string) {
    const feed = await $fetch<{ title: string, siteUrl?: string, description?: string, image?: string }>(`${base}/api/feeds/${feedId}`)

    const doc = {
      _id: `subscription:${feedId}`,
      type: 'subscription',
      feedId,
      category,
      title: feed.title,
      siteUrl: feed.siteUrl,
      description: feed.description,
      image: feed.image,
      createdAt: new Date().toISOString()
    }

    const res = await fetch(`${proxyBase}/${encodeURIComponent(doc._id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    })

    if (!res.ok && res.status !== 409) {
      throw new Error(`CouchDB insert failed: ${res.statusText}`)
    }
  }

  /** 删除订阅：先读 _rev，再删除 */
  async function removeSubscription(feedId: string) {
    const docId = `subscription:${feedId}`

    const getRes = await fetch(`${proxyBase}/${encodeURIComponent(docId)}`, { credentials: 'include' })
    if (!getRes.ok) throw new Error('subscription not found')
    const doc = await getRes.json()

    const delRes = await fetch(`${proxyBase}/${encodeURIComponent(docId)}?rev=${doc._rev}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    if (!delRes.ok) throw new Error(`CouchDB delete failed: ${delRes.statusText}`)
  }

  /** 更新订阅元信息（显示名/分类），直接读写 CouchDB 文档 */
  async function updateSubscription(feedId: string, patch: { title?: string, category?: string }) {
    const docId = `subscription:${feedId}`

    const getRes = await fetch(`${proxyBase}/${encodeURIComponent(docId)}`, { credentials: 'include' })
    if (!getRes.ok) throw new Error('subscription not found')
    const doc = await getRes.json()

    const updated = {
      ...doc,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {})
    }

    const putRes = await fetch(`${proxyBase}/${encodeURIComponent(docId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    })
    if (!putRes.ok) throw new Error(`CouchDB update failed: ${putRes.statusText}`)
  }

  return {
    listSubscriptions,
    addSubscription,
    removeSubscription,
    updateSubscription
  }
}
