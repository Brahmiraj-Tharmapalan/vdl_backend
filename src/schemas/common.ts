import { z } from 'zod'
import { isValidIsoDate } from '../lib/dates'

// Enum values match the CHECK constraints in supabase/migrations/20261019161859_initial_schema.sql.
export const VEHICLE_TYPES = ['car', 'motorbike', 'three_wheeler', 'van'] as const
export const DOCUMENT_TYPES = [
  'revenue_licence',
  'insurance',
  'emission_test',
  'registration',
  'custom',
] as const
export const THEMES = ['system', 'light', 'dark'] as const
export const PLATFORMS = ['ios', 'android'] as const
export const REMINDER_CHANNELS = ['push', 'email'] as const
export const REMINDER_STATUSES = ['scheduled', 'sent', 'failed', 'skipped'] as const

export type VehicleType = (typeof VEHICLE_TYPES)[number]
export type DocumentType = (typeof DOCUMENT_TYPES)[number]
export type Theme = (typeof THEMES)[number]
export type Platform = (typeof PLATFORMS)[number]
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number]
export type ReminderStatus = (typeof REMINDER_STATUSES)[number]

export const vehicleType = z.enum(VEHICLE_TYPES)
export const documentType = z.enum(DOCUMENT_TYPES)
export const theme = z.enum(THEMES)
export const platform = z.enum(PLATFORMS)

export const uuid = z.uuid()

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD')
  .refine(isValidIsoDate, 'Not a real calendar date')

export const plate = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(15)
  .regex(/^[A-Z0-9 -]+$/, 'Only letters, digits, spaces and hyphens are allowed')

export const nickname = z.string().trim().min(1).max(50)
export const customName = z.string().trim().min(1).max(50)

export const reminderDays = z
  .array(z.int().min(1).max(365))
  .max(6)
  .refine((days) => new Set(days).size === days.length, 'Reminder days must be unique')

/** `:id` route params. */
export const idParam = z.object({ id: uuid }).strict()
