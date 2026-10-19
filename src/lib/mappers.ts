// DB rows (snake_case) → API objects (camelCase). Explicit field picks; user_id is never exposed.
import {
  DOCUMENT_TYPES,
  PLATFORMS,
  REMINDER_CHANNELS,
  REMINDER_STATUSES,
  THEMES,
  VEHICLE_TYPES,
} from '../schemas/common'
import type { Tables } from '../types/db'
import { daysBetween, type IsoDate } from './dates'
import { computeStatus } from './status'

/** Narrows a text+CHECK column. Throws (→ 500) if the DB holds an unexpected value. */
function asEnum<const T extends readonly string[]>(allowed: T, value: string): T[number] {
  const found = allowed.find((v) => v === value)
  if (found === undefined) throw new Error('Unexpected enum value in DB row')
  return found
}

export function toProfile(row: Tables<'profiles'>) {
  return {
    displayName: row.display_name,
    reminderEmail: row.reminder_email,
    pushEnabled: row.push_enabled,
    emailEnabled: row.email_enabled,
    defaultReminderDays: row.default_reminder_days,
    theme: asEnum(THEMES, row.theme),
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  }
}

export function toVehicle(row: Tables<'vehicles'>) {
  return {
    id: row.id,
    nickname: row.nickname,
    plateNumber: row.plate_number,
    type: asEnum(VEHICLE_TYPES, row.type),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** `today` comes from `todayInColombo()`; status is computed, never stored. */
export function toDocument(row: Tables<'documents'>, today: IsoDate) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    type: asEnum(DOCUMENT_TYPES, row.type),
    customName: row.custom_name,
    expiryDate: row.expiry_date,
    reminderDays: row.reminder_days,
    pushEnabled: row.push_enabled,
    emailEnabled: row.email_enabled,
    status: computeStatus(row.expiry_date, today),
    daysLeft: daysBetween(today, row.expiry_date),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export function toReminder(row: Tables<'reminders'>) {
  return {
    id: row.id,
    documentId: row.document_id,
    daysBefore: row.days_before,
    sendOn: row.send_on,
    channel: asEnum(REMINDER_CHANNELS, row.channel),
    status: asEnum(REMINDER_STATUSES, row.status),
    sentAt: row.sent_at,
  }
}

export function toDevice(row: Tables<'devices'>) {
  return {
    id: row.id,
    platform: asEnum(PLATFORMS, row.platform),
    deviceName: row.device_name,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  }
}

export type ProfileDto = ReturnType<typeof toProfile>
export type VehicleDto = ReturnType<typeof toVehicle>
export type DocumentDto = ReturnType<typeof toDocument>
export type ReminderDto = ReturnType<typeof toReminder>
export type DeviceDto = ReturnType<typeof toDevice>
