import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { badRequest, conflict, errorBody, notFound, toErrorResponse } from '../src/lib/errors'
import { dbError, QUOTA_SQLSTATE } from '../src/lib/supabase'

describe('errorBody', () => {
  it('builds the standard shape', () => {
    expect(errorBody('not_found', 'Not found', 'r1')).toEqual({
      error: { code: 'not_found', message: 'Not found', requestId: 'r1' },
    })
  })
})

describe('toErrorResponse', () => {
  it('uses ApiError code and message', () => {
    expect(toErrorResponse(notFound('Vehicle not found'), 'r1')).toEqual({
      status: 404,
      body: errorBody('not_found', 'Vehicle not found', 'r1'),
    })
    expect(toErrorResponse(conflict(), 'r1').status).toBe(409)
    expect(toErrorResponse(badRequest(), 'r1').body.error.code).toBe('bad_request')
  })

  it('maps Hono HTTPExceptions by status with a generic message', () => {
    const res = toErrorResponse(new HTTPException(413, { message: 'internal detail' }), 'r1')
    expect(res).toEqual({ status: 413, body: errorBody('payload_too_large', 'Payload too large', 'r1') })
  })

  it('maps the timeout middleware 504 to a timeout error', () => {
    const res = toErrorResponse(new HTTPException(504, { message: 'Gateway Timeout' }), 'r1')
    expect(res).toEqual({ status: 504, body: errorBody('timeout', 'Request timed out', 'r1') })
  })

  it('turns the DB quota SQLSTATE into 409 limit_reached, other DB errors into a plain Error', () => {
    expect(toErrorResponse(dbError({ code: QUOTA_SQLSTATE, message: 'quota' }), 'r1')).toEqual({
      status: 409,
      body: errorBody('limit_reached', 'Limit reached', 'r1'),
    })
    expect(toErrorResponse(dbError({ code: '23505', message: 'dup' }), 'r1').status).toBe(500)
  })

  it('never leaks unknown errors', () => {
    const res = toErrorResponse(new Error('relation "vehicles" violates constraint'), 'r1')
    expect(res.status).toBe(500)
    expect(res.body.error).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
      requestId: 'r1',
    })
    expect(toErrorResponse(new HTTPException(502, { message: 'upstream' }), 'r1').status).toBe(500)
    expect(toErrorResponse('a string', 'r1').status).toBe(500)
  })
})
