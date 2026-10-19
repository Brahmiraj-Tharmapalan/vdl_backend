import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'

export type ErrorDetail = { path: string; message: string }

export type ErrorBody = {
  error: { code: ErrorCode; message: string; requestId: string; details?: ErrorDetail[] }
}

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorBody {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } }
}

/** Expected error. `message` is sent to the client, so it must be safe. */
export class ApiError extends HTTPException {
  readonly code: ErrorCode

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(status, { message })
    this.code = code
  }
}

export const badRequest = (message = 'Bad request') => new ApiError(400, 'bad_request', message)
export const unauthorized = (message = 'Unauthorized') => new ApiError(401, 'unauthorized', message)
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)
export const conflict = (message = 'Conflict') => new ApiError(409, 'conflict', message)
export const payloadTooLarge = (message = 'Payload too large') =>
  new ApiError(413, 'payload_too_large', message)
export const rateLimited = (message = 'Too many requests') =>
  new ApiError(429, 'rate_limited', message)

const BY_STATUS: Partial<Record<number, { code: ErrorCode; message: string }>> = {
  400: { code: 'bad_request', message: 'Bad request' },
  401: { code: 'unauthorized', message: 'Unauthorized' },
  404: { code: 'not_found', message: 'Not found' },
  409: { code: 'conflict', message: 'Conflict' },
  413: { code: 'payload_too_large', message: 'Payload too large' },
  429: { code: 'rate_limited', message: 'Too many requests' },
}

const INTERNAL = { code: 'internal_error', message: 'Internal server error' } as const

/**
 * Maps any thrown value to a safe status + body. Only ApiError messages reach the client;
 * other errors get a fixed message by status (unknown → 500).
 */
export function toErrorResponse(
  err: unknown,
  requestId: string,
): { status: ContentfulStatusCode; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.status, body: errorBody(err.code, err.message, requestId) }
  }
  if (err instanceof HTTPException) {
    const known = BY_STATUS[err.status]
    if (known) return { status: err.status, body: errorBody(known.code, known.message, requestId) }
  }
  return { status: 500, body: errorBody(INTERNAL.code, INTERNAL.message, requestId) }
}
