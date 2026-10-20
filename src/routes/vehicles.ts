import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { todayInColombo } from '../lib/dates'
import { conflict, notFound } from '../lib/errors'
import { toDocument, toVehicle } from '../lib/mappers'
import { rebuildReminders } from '../lib/reminders'
import { dbError } from '../lib/supabase'
import { validate } from '../lib/validator'
import { idParam } from '../schemas/common'
import { createDocumentBody } from '../schemas/documents'
import { createVehicleBody, updateVehicleBody, type UpdateVehicleBody } from '../schemas/vehicles'
import type { TablesUpdate } from '../types/db'

/** Same message whether the id is another user's or one of the user's deleted rows. */
export const ID_IN_USE = 'This id is already in use'

/** Only the keys the client sent, camelCase → snake_case. */
function toVehicleUpdate(body: UpdateVehicleBody): TablesUpdate<'vehicles'> {
  const update: TablesUpdate<'vehicles'> = {}
  if (body.nickname !== undefined) update.nickname = body.nickname
  if (body.plateNumber !== undefined) update.plate_number = body.plateNumber
  if (body.type !== undefined) update.type = body.type
  return update
}

const vehicles = new Hono<AppEnv>()

vehicles.get('/', async (c) => {
  const { data, error } = await c.var.supabase
    .from('vehicles')
    .select('*')
    .eq('user_id', c.var.user.id)
    .is('deleted_at', null)
    .order('created_at')
  if (error) throw dbError(error)
  return c.json({ vehicles: data.map(toVehicle) })
})

// Client-id upsert: insert (on conflict do nothing) → 201; else update the user's own live
// row → 200; else the id is taken (another account or a deleted row) → 409.
vehicles.post('/', validate('json', createVehicleBody), async (c) => {
  const body = c.req.valid('json')
  const fields = { nickname: body.nickname ?? null, plate_number: body.plateNumber, type: body.type }

  const inserted = await c.var.supabase
    .from('vehicles')
    .upsert(
      { id: body.id, user_id: c.var.user.id, ...fields },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('*')
    .maybeSingle()
  if (inserted.error) throw dbError(inserted.error)
  if (inserted.data) return c.json(toVehicle(inserted.data), 201)

  const updated = await c.var.supabase
    .from('vehicles')
    .update(fields)
    .eq('id', body.id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle()
  if (updated.error) throw dbError(updated.error)
  if (!updated.data) throw conflict(ID_IN_USE)
  return c.json(toVehicle(updated.data), 200)
})

vehicles.get('/:id', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const { data, error } = await c.var.supabase
    .from('vehicles')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  return c.json(toVehicle(data))
})

vehicles.patch(
  '/:id',
  validate('param', idParam),
  validate('json', updateVehicleBody),
  async (c) => {
    const { id } = c.req.valid('param')
    const { data, error } = await c.var.supabase
      .from('vehicles')
      .update(toVehicleUpdate(c.req.valid('json')))
      .eq('id', id)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle()
    if (error) throw dbError(error)
    if (!data) throw notFound()
    return c.json(toVehicle(data))
  },
)

// Soft delete that cascades to the vehicle's documents. Documents go first so a failed or
// retried request never leaves live documents under a deleted vehicle.
vehicles.delete('/:id', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const supabase = c.var.supabase

  const found = await supabase
    .from('vehicles')
    .select('id')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (found.error) throw dbError(found.error)
  if (!found.data) throw notFound()

  const deletedAt = new Date().toISOString()
  const docs = await supabase
    .from('documents')
    .update({ deleted_at: deletedAt })
    .eq('vehicle_id', id)
    .is('deleted_at', null)
    .select('*')
  if (docs.error) throw dbError(docs.error)
  await rebuildReminders(supabase, docs.data)

  const vehicle = await supabase
    .from('vehicles')
    .update({ deleted_at: deletedAt })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()
  if (vehicle.error) throw dbError(vehicle.error)
  if (!vehicle.data) throw notFound()
  return c.body(null, 204)
})

// Same client-id upsert as POST /vehicles. The vehicle must be the user's and not deleted.
vehicles.post(
  '/:id/documents',
  validate('param', idParam),
  validate('json', createDocumentBody),
  async (c) => {
    const { id: vehicleId } = c.req.valid('param')
    const body = c.req.valid('json')
    const supabase = c.var.supabase

    const [vehicle, profile] = await Promise.all([
      supabase
        .from('vehicles')
        .select('id')
        .eq('id', vehicleId)
        .is('deleted_at', null)
        .maybeSingle(),
      body.reminderDays
        ? null
        : supabase
            .from('profiles')
            .select('default_reminder_days')
            .eq('id', c.var.user.id)
            .maybeSingle(),
    ])
    if (vehicle.error) throw dbError(vehicle.error)
    if (!vehicle.data) throw notFound()
    if (profile?.error) throw dbError(profile.error)

    const fields = {
      type: body.type,
      custom_name: body.customName ?? null,
      expiry_date: body.expiryDate,
      // No profile row → the column default applies.
      reminder_days: body.reminderDays ?? profile?.data?.default_reminder_days,
      push_enabled: body.pushEnabled ?? true,
      email_enabled: body.emailEnabled ?? true,
    }

    const inserted = await supabase
      .from('documents')
      .upsert(
        { id: body.id, user_id: c.var.user.id, vehicle_id: vehicleId, ...fields },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      .select('*')
      .maybeSingle()
    if (inserted.error) throw dbError(inserted.error)

    let row = inserted.data
    if (!row) {
      const updated = await supabase
        .from('documents')
        .update(fields)
        .eq('id', body.id)
        .eq('vehicle_id', vehicleId)
        .is('deleted_at', null)
        .select('*')
        .maybeSingle()
      if (updated.error) throw dbError(updated.error)
      if (!updated.data) throw conflict(ID_IN_USE)
      row = updated.data
    }

    await rebuildReminders(supabase, row)
    return c.json(toDocument(row, todayInColombo()), inserted.data ? 201 : 200)
  },
)

export default vehicles
