// Pure home-screen logic: dashboard counts/upcoming and the upcoming-reminders list.
import type { Tables } from '../types/db'
import type { IsoDate } from './dates'
import { toDocument, toDocumentSummary, toReminder, toVehicleSummary } from './mappers'
import { isToRenew } from './status'

export const UPCOMING_LIMIT = 5

export type DashboardVehicle = Pick<
  Tables<'vehicles'>,
  'id' | 'nickname' | 'plate_number' | 'type' | 'deleted_at'
>

/** Soonest expiry first (so expired docs lead), then created_at, then id. */
function byExpiry(a: Tables<'documents'>, b: Tables<'documents'>): number {
  return (
    a.expiry_date.localeCompare(b.expiry_date) ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Counts only live rows, and only documents whose vehicle is also live.
 * `upcoming` = the 5 soonest-expiring live documents, expired ones included.
 */
export function buildDashboard(
  vehicles: DashboardVehicle[],
  documents: Tables<'documents'>[],
  today: IsoDate,
) {
  const live = new Map(vehicles.filter((v) => v.deleted_at === null).map((v) => [v.id, v]))
  const docs = documents.filter((d) => d.deleted_at === null && live.has(d.vehicle_id))
  const dtos = docs.map((d) => toDocument(d, today))

  const upcoming = [...docs]
    .sort(byExpiry)
    .slice(0, UPCOMING_LIMIT)
    .flatMap((d) => {
      const vehicle = live.get(d.vehicle_id)
      return vehicle ? [{ ...toDocument(d, today), vehicle: toVehicleSummary(vehicle) }] : []
    })

  return {
    counts: {
      vehicles: live.size,
      documents: dtos.length,
      toRenew: dtos.filter((d) => isToRenew(d.status)).length,
    },
    upcoming,
  }
}

export type UpcomingReminderRow = Tables<'reminders'> & {
  documents: Pick<Tables<'documents'>, 'type' | 'custom_name' | 'expiry_date' | 'deleted_at'> & {
    vehicles: Pick<Tables<'vehicles'>, 'nickname' | 'plate_number' | 'type' | 'deleted_at'>
  }
}

/** Maps reminder rows with their document + vehicle; drops any whose doc or vehicle is deleted. */
export function toUpcomingReminders(rows: UpcomingReminderRow[]) {
  return rows
    .filter((r) => r.documents.deleted_at === null && r.documents.vehicles.deleted_at === null)
    .map((r) => ({
      ...toReminder(r),
      document: toDocumentSummary(r.documents),
      vehicle: toVehicleSummary(r.documents.vehicles),
    }))
}
