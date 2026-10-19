import app from './app'

export default {
  fetch: app.fetch,
  // Daily reminder cron; implemented in cron/send-reminders.ts (P9)
  async scheduled() {},
} satisfies ExportedHandler<CloudflareBindings>
