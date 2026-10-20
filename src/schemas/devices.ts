import { z } from 'zod'
import { platform } from './common'

// Limits match the devices CHECK constraints.
export const registerDeviceBody = z
  .object({
    pushToken: z.string().trim().min(1).max(255),
    platform,
    deviceName: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()

export type RegisterDeviceBody = z.infer<typeof registerDeviceBody>
