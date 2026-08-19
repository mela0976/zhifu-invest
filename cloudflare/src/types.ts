export type GatewayEnv = Env & {
  LINE_LOGIN_CHANNEL_ID: string;
  LINE_LOGIN_CHANNEL_SECRET: string;
  LINE_LOGIN_CALLBACK_URL: string;
  LINE_MESSAGING_CHANNEL_SECRET: string;
  APPS_SCRIPT_URL: string;
  APPS_SCRIPT_SHARED_SECRET: string;
  LINE_OA_BASIC_ID?: string;
  TEST_MIGRATIONS?: unknown;
};

export type Session = {
  id: string;
  lineUserId: string;
  memberId: string | null;
  displayName: string;
  pictureUrl: string | null;
  role: 'member' | 'admin';
  friendshipStatus: 'friend' | 'not_friend' | 'unknown';
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
};

export type Actor = {
  role: 'visitor' | 'member' | 'admin';
  sessionId?: string;
  lineUserId?: string;
  memberId?: string | null;
  displayName?: string;
  friendshipStatus?: string;
};

export type AppsScriptResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
