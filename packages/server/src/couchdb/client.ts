import nano from "nano"
import PouchDB from "pouchdb-node"
import { COUCHDB_GLOBAL } from "../db"

const couchUrl = process.env.COUCHDB_URL ?? "http://localhost:5984"

export const nanoServer = nano(couchUrl)

const GLOBAL_DESIGN_DOC = {
  _id: "_design/main",
  language: "javascript",
  views: {
    "entries-by-feed": {
      map: `function(doc) {
        if (doc.type === 'entry' && doc.feedId) {
          emit(doc.feedId, { _id: doc._id, publishedAt: doc.publishedAt });
        }
      }`,
    },
    "entries-by-date": {
      map: `function(doc) {
        if (doc.type === 'entry') {
          emit(doc.publishedAt, { _id: doc._id, feedId: doc.feedId });
        }
      }`,
    },
    "feeds-all": {
      map: `function(doc) {
        if (doc.type === 'feed') emit(doc._id, { url: doc.url, title: doc.title });
      }`,
    },
  },
  filters: {
    "entries-by-feeds": `function(doc, req) {
      if (doc.type !== 'entry') return false;
      var feedIds = JSON.parse(req.query.feed_ids || '[]');
      return feedIds.indexOf(doc.feedId) !== -1;
    }`,
  },
}

export async function ensureGlobalDatabase() {
  try {
    await nanoServer.db.get(COUCHDB_GLOBAL)
  } catch {
    await nanoServer.db.create(COUCHDB_GLOBAL)
  }
  await installDesignDoc(COUCHDB_GLOBAL)
}

export async function ensureUserDatabase(userId: string) {
  const dbName = `rssfed-user:${userId}`
  try {
    await nanoServer.db.get(dbName)
  } catch {
    await nanoServer.db.create(dbName)
  }
}

export function getUserPouch(userId: string): PouchDB.Database {
  return new PouchDB(`${couchUrl}/rssfed-user:${userId}`)
}

export function getGlobalPouch(): PouchDB.Database {
  return new PouchDB(`${couchUrl}/${COUCHDB_GLOBAL}`)
}

async function installDesignDoc(dbName: string) {
  const db = nanoServer.use(dbName)
  try {
    const existing = await db.get("_design/main")
    await db.insert({ ...GLOBAL_DESIGN_DOC, _rev: existing._rev })
  } catch {
    await db.insert(GLOBAL_DESIGN_DOC)
  }
}