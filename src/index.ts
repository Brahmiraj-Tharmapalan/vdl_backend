import app from './app'
import { sendReminders } from './cron/send-reminders'

export default {
  fetch: app.fetch,
  // Daily reminder cron (`0 2 * * *`); sendReminders never rejects and logs its own summary.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendReminders(env, controller.scheduledTime))
  },
} satisfies ExportedHandler<CloudflareBindings>
