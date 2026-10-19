import { zValidator, type Hook } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import type { AppEnv } from '../env'
import { errorBody, type ErrorDetail } from './errors'

/** Path and message only; never the input value. */
export function toErrorDetails(error: z.core.$ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

/**
 * zod validator for `json`, `query`, `param`, ... On failure responds 400 in the standard
 * error shape. Read the result with `c.req.valid(target)`.
 */
export const validate = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator<T, Target, AppEnv, string, Hook<z.infer<T>, AppEnv, string, Target, {}, T>>(
    target,
    schema,
    (result, c) => {
      if (!result.success) {
        const details = toErrorDetails(result.error)
        return c.json(
          errorBody('validation_failed', 'Invalid request', c.var.requestId ?? 'unknown', details),
          400,
        )
      }
    },
  )
