import { z } from 'zod'

export const UPCOMING_REMINDERS_MAX = 100

/** `?limit=` for GET /v1/reminders/upcoming. */
export const upcomingRemindersQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(UPCOMING_REMINDERS_MAX).default(50) })
  .strict()
