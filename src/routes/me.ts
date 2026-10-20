import { Hono } from 'hono'
import type { AppEnv, AuthUser } from '../env'
import { errorBody, notFound, reauthRequired } from '../lib/errors'
import { toProfile } from '../lib/mappers'
import { rebuildAllReminders } from '../lib/reminders'
import { dbError, serviceClient } from '../lib/supabase'
import { validate } from '../lib/validator'
import { strictRateLimit } from '../middleware/rate-limit'
import { updateProfileBody, type UpdateProfileBody } from '../schemas/me'
import type { Tables, TablesUpdate } from '../types/db'

const toMe = (user: AuthUser, row: Tables<'profiles'>) => ({
  id: user.id,
  email: user.email ?? null,
  ...toProfile(row),
})

/** Only the keys the client sent, camelCase → snake_case. */
function toProfileUpdate(body: UpdateProfileBody): TablesUpdate<'profiles'> {
  const update: TablesUpdate<'profiles'> = {}
  if (body.displayName !== undefined) update.display_name = body.displayName
  if (body.reminderEmail !== undefined) update.reminder_email = body.reminderEmail
  if (body.pushEnabled !== undefined) update.push_enabled = body.pushEnabled
  if (body.emailEnabled !== undefined) update.email_enabled = body.emailEnabled
  if (body.defaultReminderDays !== undefined) update.default_reminder_days = body.defaultReminderDays
  if (body.theme !== undefined) update.theme = body.theme
  return update
}

/** DELETE /me needs a sign-in this recent, so a leaked token alone can't delete the account. */
export const REAUTH_WINDOW_S = 10 * 60

/**
 * Reminders may only go to the account's own (provider-verified) email, so the service can't be
 * used to mail strangers. Compared case-insensitively.
 */
const isOwnEmail = (user: AuthUser, email: string) =>
  user.email !== undefined && user.email.toLowerCase() === email.toLowerCase()

const me = new Hono<AppEnv>()

me.get('/', async (c) => {
  const { data, error } = await c.var.supabase
    .from('profiles')
    .select('*')
    .eq('id', c.var.user.id)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  return c.json(toMe(c.var.user, data))
})

me.patch('/', validate('json', updateProfileBody), async (c) => {
  const body = c.req.valid('json')
  if (body.reminderEmail && !isOwnEmail(c.var.user, body.reminderEmail)) {
    const details = [{ path: 'reminderEmail', message: 'Must be the email you signed in with' }]
    return c.json(errorBody('validation_failed', 'Invalid request', c.var.requestId, details), 400)
  }
  const { data, error } = await c.var.supabase
    .from('profiles')
    .update(toProfileUpdate(body))
    .eq('id', c.var.user.id)
    .select('*')
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  // Reminder rows exist only for channels on in both profile and document.
  if (body.pushEnabled !== undefined || body.emailEnabled !== undefined) {
    await rebuildAllReminders(c.var.supabase)
  }
  return c.json(toMe(c.var.user, data))
})

// Deleting the auth user cascades to every synced row (all FKs are on delete cascade).
// The only route allowed to use the service-role client (AGENTS.md rule 7).
me.delete('/', strictRateLimit, async (c) => {
  const { signedInAt } = c.var.user
  if (signedInAt === undefined || Date.now() / 1000 - signedInAt > REAUTH_WINDOW_S) {
    throw reauthRequired()
  }
  const { error } = await serviceClient(c.env).auth.admin.deleteUser(c.var.user.id)
  if (error) throw dbError(error)
  return c.body(null, 204)
})

export default me
