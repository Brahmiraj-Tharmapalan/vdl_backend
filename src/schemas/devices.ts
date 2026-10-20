import { z } from 'zod'
import { platform } from './common'

/**
 * Expo push tokens only. Expo rejects a whole request over some bad tokens, and a chunk mixes
 * users, so one junk token could fail other users' pushes. Matches the devices CHECK.
 */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/

// Limits match the devices CHECK constraints.
export const registerDeviceBody = z
  .object({
    pushToken: z.string().trim().min(1).max(255).regex(EXPO_PUSH_TOKEN, 'Expected an Expo push token'),
    platform,
    deviceName: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()

export type RegisterDeviceBody = z.infer<typeof registerDeviceBody>
