import { z } from 'zod'
import { nickname, plate, uuid, vehicleType } from './common'

const vehicleFields = {
  nickname: nickname.nullable(),
  plateNumber: plate,
  type: vehicleType,
}

/** POST is a full representation: a missing nickname resets it to null. */
export const createVehicleBody = z
  .object({ id: uuid, ...vehicleFields, nickname: vehicleFields.nickname.optional() })
  .strict()

export const updateVehicleBody = z
  .object(vehicleFields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required')

export type CreateVehicleBody = z.infer<typeof createVehicleBody>
export type UpdateVehicleBody = z.infer<typeof updateVehicleBody>
