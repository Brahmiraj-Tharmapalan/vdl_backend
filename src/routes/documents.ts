import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { todayInColombo } from '../lib/dates'
import { errorBody, notFound } from '../lib/errors'
import { toDocument } from '../lib/mappers'
import { rebuildReminders, remindersChanged } from '../lib/reminders'
import { isToRenew } from '../lib/status'
import { dbError } from '../lib/supabase'
import { validate } from '../lib/validator'
import { idParam } from '../schemas/common'
import {
  CUSTOM_NAME_RULE,
  customNameValid,
  documentsQuery,
  updateDocumentBody,
  type UpdateDocumentBody,
} from '../schemas/documents'
import type { Tables, TablesUpdate } from '../types/db'

/** Only the keys the client sent; switching away from `custom` clears the custom name. */
function toDocumentUpdate(body: UpdateDocumentBody): TablesUpdate<'documents'> {
  const update: TablesUpdate<'documents'> = {}
  if (body.type !== undefined) update.type = body.type
  if (body.type !== undefined && body.type !== 'custom') update.custom_name = null
  if (body.customName !== undefined) update.custom_name = body.customName
  if (body.expiryDate !== undefined) update.expiry_date = body.expiryDate
  if (body.reminderDays !== undefined) update.reminder_days = body.reminderDays
  if (body.pushEnabled !== undefined) update.push_enabled = body.pushEnabled
  if (body.emailEnabled !== undefined) update.email_enabled = body.emailEnabled
  return update
}

const documents = new Hono<AppEnv>()

documents.get('/', validate('query', documentsQuery), async (c) => {
  const { filter } = c.req.valid('query')
  const { data, error } = await c.var.supabase
    .from('documents')
    .select('*')
    .eq('user_id', c.var.user.id)
    .is('deleted_at', null)
    .order('expiry_date')
  if (error) throw dbError(error)
  const today = todayInColombo()
  const all = data.map((row) => toDocument(row, today))
  const docs =
    filter === 'all' ? all : all.filter((d) => isToRenew(d.status) === (filter === 'to_renew'))
  return c.json({ documents: docs })
})

documents.get('/:id', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const { data, error } = await c.var.supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  return c.json(toDocument(data, todayInColombo()))
})

// A new expiryDate is the Renew action. The custom-name rule is checked on the merged row.
documents.patch(
  '/:id',
  validate('param', idParam),
  validate('json', updateDocumentBody),
  async (c) => {
    const { id } = c.req.valid('param')
    const supabase = c.var.supabase

    const current = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()
    if (current.error) throw dbError(current.error)
    if (!current.data) throw notFound()

    const update = toDocumentUpdate(c.req.valid('json'))
    const merged: Tables<'documents'> = { ...current.data, ...update }
    if (!customNameValid(merged.type, merged.custom_name)) {
      const details = [{ path: 'customName', message: CUSTOM_NAME_RULE }]
      return c.json(
        errorBody('validation_failed', 'Invalid request', c.var.requestId, details),
        400,
      )
    }

    const { data, error } = await supabase
      .from('documents')
      .update(update)
      .eq('id', id)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle()
    if (error) throw dbError(error)
    if (!data) throw notFound()

    if (remindersChanged(current.data, data)) await rebuildReminders(supabase, data)
    return c.json(toDocument(data, todayInColombo()))
  },
)

documents.delete('/:id', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const { data, error } = await c.var.supabase
    .from('documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  await rebuildReminders(c.var.supabase, data)
  return c.body(null, 204)
})

export default documents
