import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { buildDashboard } from '../lib/dashboard'
import { todayInColombo } from '../lib/dates'
import { dbError } from '../lib/supabase'

const dashboard = new Hono<AppEnv>()

// The live vehicles give both the vehicle count and the join for each upcoming document.
dashboard.get('/', async (c) => {
  const supabase = c.var.supabase
  const userId = c.var.user.id
  const [vehicles, documents] = await Promise.all([
    supabase
      .from('vehicles')
      .select('id, nickname, plate_number, type, deleted_at')
      .eq('user_id', userId)
      .is('deleted_at', null),
    supabase.from('documents').select('*').eq('user_id', userId).is('deleted_at', null),
  ])
  if (vehicles.error) throw dbError(vehicles.error)
  if (documents.error) throw dbError(documents.error)
  return c.json(buildDashboard(vehicles.data, documents.data, todayInColombo()))
})

export default dashboard
