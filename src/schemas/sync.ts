import { z } from 'zod'
import { isTooFarInFuture, MAX_FUTURE_SKEW_MS, MAX_SYNC_ROWS } from '../lib/sync'
import { customName, documentType, isoDate, nickname, plate, reminderDays, uuid, vehicleType } from './common'
import { CUSTOM_NAME_RULE, customNameValid } from './documents'

const timestamp = z.iso.datetime({ offset: true })

/** A client clock may not run more than 5 minutes ahead of the server. */
const clientTimestamp = timestamp.refine(
  (ts) => !isTooFarInFuture(ts, new Date()),
  `Must not be more than ${MAX_FUTURE_SKEW_MS / 60_000} minutes in the future`,
)

const uniqueIds = (rows: readonly { id: string }[]) =>
  new Set(rows.map((r) => r.id)).size === rows.length

/** A full local row. Omitted nickname/deletedAt = null. */
export const syncVehicle = z
  .object({
    id: uuid,
    nickname: nickname.nullable().optional(),
    plateNumber: plate,
    type: vehicleType,
    updatedAt: clientTimestamp,
    deletedAt: clientTimestamp.nullable().optional(),
  })
  .strict()

/** A full local row: reminder settings are required (the app always has them). */
export const syncDocument = z
  .object({
    id: uuid,
    vehicleId: uuid,
    type: documentType,
    customName: customName.nullable().optional(),
    expiryDate: isoDate,
    reminderDays,
    pushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    updatedAt: clientTimestamp,
    deletedAt: clientTimestamp.nullable().optional(),
  })
  .strict()
  .refine((doc) => customNameValid(doc.type, doc.customName), {
    message: CUSTOM_NAME_RULE,
    path: ['customName'],
  })

const rows = <T extends z.ZodType<{ id: string }>>(row: T) =>
  z.array(row).max(MAX_SYNC_ROWS).refine(uniqueIds, 'Ids must be unique').default([])

export const syncBody = z
  .object({
    /** The previous response's serverTime; null = full pull. */
    lastSyncedAt: timestamp.nullable(),
    changes: z
      .object({ vehicles: rows(syncVehicle), documents: rows(syncDocument) })
      .strict(),
  })
  .strict()

export type SyncBody = z.infer<typeof syncBody>
