import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { toUpcomingReminders } from '../lib/dashboard'
import { todayInColombo } from '../lib/dates'
import { dbError } from '../lib/supabase'
import { validate } from '../lib/validator'
import { upcomingRemindersQuery } from '../schemas/reminders'

const UPCOMING_SELECT =
  '*, documents!inner(type, custom_name, expiry_date, deleted_at, vehicles!documents_vehicle_same_user_fkey!inner(nickname, plate_number, type, deleted_at))'

const reminders = new Hono<AppEnv>()

// Scheduled reminders from today (Colombo) on, for live documents on live vehicles.
reminders.get('/upcoming', validate('query', upcomingRemindersQuery), async (c) => {
  const { limit } = c.req.valid('query')
  const { data, error } = await c.var.supabase
    .from('reminders')
    .select(UPCOMING_SELECT)
    .eq('user_id', c.var.user.id)
    .eq('status', 'scheduled')
    .gte('send_on', todayInColombo())
    .is('documents.deleted_at', null)
    .is('documents.vehicles.deleted_at', null)
    .order('send_on')
    .order('id')
    .limit(limit)
  if (error) throw dbError(error)
  return c.json({ reminders: toUpcomingReminders(data) })
})

export default reminders
