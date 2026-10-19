import { Hono } from 'hono'
import type { AppEnv } from './env'

const app = new Hono<AppEnv>()

app.get('/v1/health', (c) => c.json({ status: 'ok' }))

export default app
