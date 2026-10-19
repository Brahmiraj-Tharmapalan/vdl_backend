import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppEnv } from '../src/env'
import type { ErrorBody } from '../src/lib/errors'
import { validate } from '../src/lib/validator'
import { idParam, plate } from '../src/schemas/common'

const app = new Hono<AppEnv>()
app.use(async (c, next) => {
  c.set('requestId', 'req-1')
  await next()
})
app.post('/things/:id', validate('param', idParam), validate('json', z.object({ plate }).strict()), (c) => {
  const { id } = c.req.valid('param')
  const { plate } = c.req.valid('json')
  return c.json({ id, plate })
})

const ID = '0b6c8d4e-3f2a-4c1b-9d8e-7f6a5b4c3d2e'
const post = (id: string, body: unknown) =>
  app.request(`/things/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('validate', () => {
  it('passes parsed (transformed) values to the handler', async () => {
    const res = await post(ID, { plate: ' cab-1234 ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: ID, plate: 'CAB-1234' })
  })

  it('returns 400 in the standard shape for a bad param', async () => {
    const res = await post('nope', { plate: 'CAB-1234' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.requestId).toBe('req-1')
    expect(body.error.details?.[0]?.path).toBe('id')
  })

  it('rejects unknown fields', async () => {
    const res = await post(ID, { plate: 'CAB-1234', owner: 'x' })
    expect(res.status).toBe(400)
  })

  it('returns path + message only, never the input value', async () => {
    const secret = 'SECRET_VALUE_123'
    const res = await post(ID, { plate: `${secret}!` })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(secret)
    const body = JSON.parse(text) as ErrorBody
    for (const d of body.error.details ?? []) {
      expect(Object.keys(d).sort()).toEqual(['message', 'path'])
    }
    expect(body.error.details?.[0]?.path).toBe('plate')
  })

  it('reports nested paths with dots', async () => {
    const nested = new Hono<AppEnv>().post(
      '/',
      validate('json', z.object({ days: z.array(z.int()) })),
      (c) => c.json(c.req.valid('json')),
    )
    const res = await nested.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: [1, 'x'] }),
    })
    const body = (await res.json()) as ErrorBody
    expect(body.error.details?.[0]?.path).toBe('days.1')
  })
})
