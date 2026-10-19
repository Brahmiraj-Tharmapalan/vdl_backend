import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('GET /v1/health', () => {
  it('returns 200 without auth', async () => {
    const res = await exports.default.fetch('https://example.com/v1/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
