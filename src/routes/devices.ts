import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { notFound } from '../lib/errors'
import { toDevice } from '../lib/mappers'
import { dbError } from '../lib/supabase'
import { validate } from '../lib/validator'
import { strictRateLimit } from '../middleware/rate-limit'
import { idParam } from '../schemas/common'
import { registerDeviceBody } from '../schemas/devices'

const devices = new Hono<AppEnv>()

devices.get('/', async (c) => {
  const { data, error } = await c.var.supabase
    .from('devices')
    .select('*')
    .eq('user_id', c.var.user.id)
    .order('created_at')
  if (error) throw dbError(error)
  return c.json({ devices: data.map(toDevice) })
})

// Upsert by push token. The RPC takes over a token held by another account
// (a phone that switched users); user_id comes from auth.uid() in the DB.
devices.post('/', strictRateLimit, validate('json', registerDeviceBody), async (c) => {
  const body = c.req.valid('json')
  const { data, error } = await c.var.supabase
    .rpc('register_device', {
      p_push_token: body.pushToken,
      p_platform: body.platform,
      p_device_name: body.deviceName ?? undefined,
    })
    .single()
  if (error) throw dbError(error)
  return c.json(toDevice(data))
})

devices.patch('/:id/seen', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const { data, error } = await c.var.supabase
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  return c.json(toDevice(data))
})

devices.delete('/:id', validate('param', idParam), async (c) => {
  const { id } = c.req.valid('param')
  const { data, error } = await c.var.supabase
    .from('devices')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) throw dbError(error)
  if (!data) throw notFound()
  return c.body(null, 204)
})

export default devices
