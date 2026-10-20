import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  // The first exports.default.fetch cold-boots the Worker entry (~4 s alone, more under load).
  test: { testTimeout: 20_000 },
})
