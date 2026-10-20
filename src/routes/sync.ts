import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { todayInColombo } from '../lib/dates'
import { dbError } from '../lib/supabase'
import { parseSyncResult, toSyncParams, toSyncResponse } from '../lib/sync'
import { validate } from '../lib/validator'
import { strictRateLimit } from '../middleware/rate-limit'
import { syncBody } from '../schemas/sync'

const sync = new Hono<AppEnv>()

// Push + pull in one `sync_changes` transaction: merge (LWW, delete wins), per-row rejections,
// cascade, reminder rebuild, last_synced_at, then every row changed since lastSyncedAt.
sync.post('/', strictRateLimit, validate('json', syncBody), async (c) => {
  const { data, error } = await c.var.supabase.rpc(
    'sync_changes',
    toSyncParams(c.req.valid('json')),
  )
  if (error) throw dbError(error)
  return c.json(toSyncResponse(parseSyncResult(data), todayInColombo()))
})

export default sync
