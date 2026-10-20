import { z } from 'zod'
import { customName, documentType, isoDate, reminderDays, uuid } from './common'

export const CUSTOM_NAME_RULE = 'customName is required for custom documents and not allowed otherwise'

/** customName is required iff type is `custom`. Also applied to the merged row on PATCH. */
export function customNameValid(type: string, name: string | null | undefined): boolean {
  return type === 'custom' ? name != null : name == null
}

/** POST is a full representation: missing optional fields reset to their defaults. */
export const createDocumentBody = z
  .object({
    id: uuid,
    type: documentType,
    customName: customName.nullable().optional(),
    expiryDate: isoDate,
    reminderDays: reminderDays.optional(),
    pushEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => customNameValid(body.type, body.customName), {
    message: CUSTOM_NAME_RULE,
    path: ['customName'],
  })

/** A new expiryDate is the Renew action. The custom-name rule is checked on the merged row. */
export const updateDocumentBody = z
  .object({
    type: documentType,
    customName: customName.nullable(),
    expiryDate: isoDate,
    reminderDays,
    pushEnabled: z.boolean(),
    emailEnabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one field is required')

export const DOCUMENT_FILTERS = ['all', 'to_renew', 'valid'] as const

export const documentsQuery = z
  .object({ filter: z.enum(DOCUMENT_FILTERS).default('all') })
  .strict()

export type CreateDocumentBody = z.infer<typeof createDocumentBody>
export type UpdateDocumentBody = z.infer<typeof updateDocumentBody>
