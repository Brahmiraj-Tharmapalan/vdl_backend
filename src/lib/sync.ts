import { z } from 'zod'
import type { SyncBody } from '../schemas/sync'
import type { Database, Json, Tables } from '../types/db'
import type { IsoDate } from './dates'
import { toDocument, toVehicle } from './mappers'

/** Max rows per array (vehicles, documents) in one push. */
export const MAX_SYNC_ROWS = 500
/** Client timestamps may run at most this far ahead of the server clock. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export function isTooFarInFuture(timestamp: string, now: Date): boolean {
  return Date.parse(timestamp) - now.getTime() > MAX_FUTURE_SKEW_MS
}

/**
 * Whether an incoming row replaces the server's. Mirrors the merge rule in the `sync_changes`
 * SQL function, which is the source of truth (supabase/migrations/*_sync.sql); keep them in
 * sync. Last write wins on the client's updatedAt, and a delete always wins: an incoming delete
 * always applies, and a row already deleted on the server never changes again.
 */
export function shouldApply(
  server: Pick<Tables<'vehicles'>, 'client_updated_at' | 'deleted_at'> | null,
  incoming: { updatedAt: string; deletedAt: string | null },
): boolean {
  if (server === null) return true
  if (server.deleted_at !== null) return false
  if (incoming.deletedAt !== null) return true
  return Date.parse(server.client_updated_at) < Date.parse(incoming.updatedAt)
}

type SyncArgs = Database['public']['Functions']['sync_changes']['Args']

/** Request body → RPC args (snake_case). user_id is never sent; the RPC uses auth.uid(). */
export function toSyncParams(body: SyncBody): SyncArgs {
  const vehicles: Json = body.changes.vehicles.map((v) => ({
    id: v.id,
    nickname: v.nickname ?? null,
    plate_number: v.plateNumber,
    type: v.type,
    updated_at: v.updatedAt,
    deleted_at: v.deletedAt ?? null,
  }))
  const documents: Json = body.changes.documents.map((d) => ({
    id: d.id,
    vehicle_id: d.vehicleId,
    type: d.type,
    custom_name: d.customName ?? null,
    expiry_date: d.expiryDate,
    reminder_days: d.reminderDays,
    push_enabled: d.pushEnabled,
    email_enabled: d.emailEnabled,
    updated_at: d.updatedAt,
    deleted_at: d.deletedAt ?? null,
  }))
  const args: SyncArgs = { p_vehicles: vehicles, p_documents: documents }
  // Omitted = SQL default null = full pull.
  if (body.lastSyncedAt !== null) args.p_last_synced_at = body.lastSyncedAt
  return args
}

const vehicleRow = z.object({
  id: z.string(),
  user_id: z.string(),
  nickname: z.string().nullable(),
  plate_number: z.string(),
  type: z.string(),
  client_updated_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}) satisfies z.ZodType<Tables<'vehicles'>>

const documentRow = z.object({
  id: z.string(),
  user_id: z.string(),
  vehicle_id: z.string(),
  type: z.string(),
  custom_name: z.string().nullable(),
  expiry_date: z.string(),
  reminder_days: z.array(z.number()),
  push_enabled: z.boolean(),
  email_enabled: z.boolean(),
  client_updated_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}) satisfies z.ZodType<Tables<'documents'>>

const rejectedRow = z.object({
  entity: z.enum(['vehicle', 'document']),
  id: z.string(),
  reason: z.enum(['id_in_use', 'vehicle_not_found']),
})

const syncResult = z.object({
  server_time: z.string(),
  rejected: z.array(rejectedRow),
  vehicles: z.array(vehicleRow),
  documents: z.array(documentRow),
})

export type SyncResult = z.infer<typeof syncResult>
export type SyncRejection = z.infer<typeof rejectedRow>

/** Validates the RPC's jsonb result. A malformed result is a server bug → 500. */
export function parseSyncResult(data: Json): SyncResult {
  const parsed = syncResult.safeParse(data)
  // No zod message: the log must not carry row values.
  if (!parsed.success) throw new Error('Unexpected sync_changes result shape')
  return parsed.data
}

/**
 * RPC result → API response. serverTime is the cursor for the next lastSyncedAt; it is
 * normalized to ms precision, which only rounds it down (more re-delivery, never a gap).
 */
export function toSyncResponse(result: SyncResult, today: IsoDate) {
  return {
    serverTime: new Date(result.server_time).toISOString(),
    vehicles: result.vehicles.map(toVehicle),
    documents: result.documents.map((row) => toDocument(row, today)),
    rejected: result.rejected,
  }
}

export type SyncResponse = ReturnType<typeof toSyncResponse>
