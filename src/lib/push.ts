// Expo Push API client: https://docs.expo.dev/push-notifications/sending-notifications/
// Only push tickets are read. Receipts (available ~15 min later) are out of scope.

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_CHUNK_SIZE = 100

export type PushMessage = {
  to: string
  title: string
  body: string
  sound: 'default'
  data: Record<string, string>
}

/** Per-message outcome. `error` is a short code, never Expo's message (it contains the token). */
export type PushOutcome =
  | { ok: true }
  | { ok: false; error: string; deviceNotRegistered: boolean }

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const CODE_RE = /^[A-Za-z_]{1,64}$/

function ticketOutcome(ticket: unknown): PushOutcome {
  if (typeof ticket !== 'object' || ticket === null) {
    return { ok: false, error: 'expo_bad_ticket', deviceNotRegistered: false }
  }
  const t = ticket as { status?: unknown; details?: { error?: unknown } }
  if (t.status === 'ok') return { ok: true }
  const code = t.details?.error
  const safe = typeof code === 'string' && CODE_RE.test(code) ? code : 'error'
  return { ok: false, error: `expo_${safe}`, deviceNotRegistered: code === 'DeviceNotRegistered' }
}

/**
 * Sends one chunk (≤ 100 messages) in a single request. Returns one outcome per message, in
 * order. A failed request fails every message in the chunk with `expo_<status>`.
 */
export async function sendPushChunk(
  messages: readonly PushMessage[],
  accessToken: string,
): Promise<PushOutcome[]> {
  const failAll = (error: string): PushOutcome[] =>
    messages.map(() => ({ ok: false, error, deviceNotRegistered: false }))

  let res: Response
  try {
    res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(messages),
    })
  } catch {
    return failAll('expo_network')
  }
  if (!res.ok) return failAll(`expo_${res.status}`)

  let data: unknown
  try {
    data = ((await res.json()) as { data?: unknown }).data
  } catch {
    return failAll('expo_bad_response')
  }
  if (!Array.isArray(data) || data.length !== messages.length) return failAll('expo_bad_response')
  return data.map(ticketOutcome)
}
