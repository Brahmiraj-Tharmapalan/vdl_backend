import { z } from 'zod'
import { reminderDays, theme } from './common'

// Limits match the profiles CHECK constraints.
export const updateProfileBody = z
  .object({
    displayName: z.string().trim().min(1).max(100).nullable(),
    reminderEmail: z.email().max(254).nullable(),
    pushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    defaultReminderDays: reminderDays,
    theme,
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required')

export type UpdateProfileBody = z.infer<typeof updateProfileBody>
