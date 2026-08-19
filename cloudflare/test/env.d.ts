declare namespace Cloudflare {
  interface Env {
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    LINE_LOGIN_CALLBACK_URL: string;
    LINE_MESSAGING_CHANNEL_SECRET: string;
    APPS_SCRIPT_URL: string;
    APPS_SCRIPT_SHARED_SECRET: string;
    LINE_OA_BASIC_ID?: string;
    TEST_MIGRATIONS: unknown;
  }
}
