import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './cloudflare/wrangler.jsonc' },
      miniflare: {
        // Installed workerd build (2026-08-11) predates today's deployment date.
        compatibilityDate: '2026-08-11',
        bindings: {
          TEST_MIGRATIONS: migrations,
          LINE_LOGIN_CHANNEL_ID: 'test-line-channel',
          LINE_LOGIN_CHANNEL_SECRET: 'test-line-login-secret',
          LINE_LOGIN_CALLBACK_URL: 'https://gateway.example/api/auth/line/callback',
          LINE_MESSAGING_CHANNEL_SECRET: 'test-line-messaging-secret',
          APPS_SCRIPT_URL: 'https://script.google.com/macros/s/test/exec',
          APPS_SCRIPT_SHARED_SECRET: 'test-apps-script-secret',
        },
      },
    }),
  ],
  test: {
    include: ['./cloudflare/test/**/*.test.ts'],
    setupFiles: ['./cloudflare/test/setup.ts'],
  },
});
