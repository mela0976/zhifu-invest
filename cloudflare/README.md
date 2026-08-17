# 致富投資 Cloudflare Gateway

這個 Worker 是 GitHub Pages 與 Google Apps Script 之間的安全邊界。它負責 LINE Login、8 小時伺服器端 session、LINE webhook 原始內容驗簽、Apps Script 簽章轉送，以及 5 分鐘且綁定同一 session 的 R2 Pitch Deck 下載。

## 架構與責任

- **D1 `DB`**：OAuth state/nonce、session、一次性短效 deck token，以及可重試的 LINE webhook 工作佇列。
- **R2 `DECKS`**：受保護 Pitch Deck；物件不公開，僅由 Worker 串流。
- **Apps Script**：會員、專案、認購、管理儀表板等營運資料來源。
- **Worker**：來源白名單、credentialed CORS、可信 `Origin` + session 專屬 `X-CSRF-Token`、角色 gate、簽章與秘密管理。

## Worker → Apps Script 契約

所有請求皆為 `POST APPS_SCRIPT_URL`、`Content-Type: application/json`，body 固定為：

```json
{
  "timestamp": 1786982400000,
  "nonce": "random-base64url",
  "operation": "listProjects",
  "payloadJson": "{\"requestId\":\"...\"}",
  "signature": "HMAC-SHA256-base64"
}
```

`payloadJson` 必須只做一次 `JSON.stringify`。簽章 canonical string 為：

```text
timestamp + "\n" + nonce + "\n" + operation + "\n" + payloadJson
```

Apps Script 用 `APPS_SCRIPT_SHARED_SECRET` 驗 HMAC-SHA256 base64，並拒絕逾時或已用過的 `(timestamp, nonce)`。回應只能是：

```json
{ "ok": true, "data": {} }
```

或：

```json
{ "ok": false, "error": { "code": "forbidden", "message": "..." } }
```

### Operation mapping

| HTTP route | Apps Script operation | Gateway access |
|---|---|---|
| `GET /api/projects` | `listProjects` | Public |
| `GET /api/auth/me` profile enrichment | `getMember` | Current member only |
| `GET /api/projects/:projectId` | `getProject` | Public; Apps Script redacts protected fields |
| `POST /api/activation` | `createActivation` | Member/Admin |
| `GET /api/bookings` | `adminList(resource=bookings)` | Admin |
| `POST /api/bookings` | `createBooking` | Public trusted origin |
| `GET /api/subscriptions` | `listSubscriptions` | Member/Admin |
| `POST /api/subscriptions` | `createSubscription` | Member/Admin |
| `GET /api/admin/dashboard`, `/overview`, `/actions` | `adminDashboard` | Admin |
| `GET /api/admin/{members,projects,subscriptions,notifications,audits}` | `adminList` | Admin |
| `GET /api/admin/referrers` | `adminList(resource=referrers)` | Admin |
| `POST /api/admin/referrers` | `adminCreateReferrer` | Admin |
| `PATCH /api/admin/referrers/:referrerId` | `adminPatchReferrer` | Admin |
| `GET /api/admin/commissions` | `adminList(resource=commissions)` | Admin |
| `PATCH /api/admin/commissions/:subscriptionId` | `adminPatchCommission` | Admin |
| `PATCH /api/admin/members/:memberId` | `adminPatchMember` | Admin |
| `PATCH /api/admin/projects/:projectId` | `adminPatchProject` | Admin |
| `PATCH /api/admin/subscriptions/:subscriptionId` | `adminPatchSubscription` | Admin |
| `POST /api/admin/notifications` | `adminCreateBulkNotification` | Admin |
| `POST /api/admin/notifications/:notificationId/send` | `adminApproveNotification` | Admin |
| `POST /api/admin/notifications/process` | `adminProcessNotifications` | Admin |
| `GET /api/admin/export[s]/{members,subscriptions,referrers,commissions}.csv` | `adminExport` | Admin |
| LINE callback member mapping | `upsertLineMember` | Worker internal/service |
| `POST /api/auth/admin` Google + 2FA | `authenticateAdmin` | Worker internal/service |
| Deck permission check | `authorizeDeck` | Worker internal, authenticated |
| Successful deck stream audit | `deckDownloadAudit` | Worker internal, background |
| Verified LINE webhook | `webhookEvent`，成功後才標記 delivered | Worker internal/service |

每個 `payloadJson` 都含 Worker 產生的 `context`（role、actorId、memberId、requestId），再依 operation 加入明確欄位。Apps Script 不得相信瀏覽器自行提供的會員或角色欄位。

分潤 mutation 的 canonical HTTP body 固定為：

```json
{
  "action": "approve | pay | void",
  "approvalReference": "approve 時必填",
  "payoutReference": "pay 時必填",
  "voidReason": "void 時必填",
  "reason": "每個動作必填"
}
```

Worker 只把上述欄位與 path 的 `subscriptionId` 送入 `adminPatchCommission`。所有 member access
route 以及 `/api/auth/me` 在回應前會再移除 `commission*`、`referralSnapshot*`、
`referralAttribution*`、`evidenceReference`、`referrerName`；只有 admin route 保留完整資料。

引薦方 POST／PATCH 採 canonical 欄位：`code,displayName,legalName,contactName,contactEmail,status,
defaultCommissionRateBps,commissionBasis,agreementReference,effectiveAt,expiresAt`，並把 `reason` 放在
同一 HTTP body。會員歸因 PATCH 使用 `referralAttribution:{referrerId,evidenceReference}`；Worker
會原樣放入 Apps Script 的 `patch.referralAttribution`，不接受其他歷史欄位名稱。
管理員 dashboard 回應保留 `overview,kpis,referrers,members,subscriptions,commissions,actions`。

## LINE Login 與 webhook

1. `GET /api/auth/line` 建立隨機 state + nonce，hash state 後存入 D1，導向 LINE。
2. callback 原子消耗 state，向 LINE token endpoint 換 token，再呼叫官方 `/oauth2/v2.1/verify` 並提交 nonce。
3. Worker 查 `/friendship/v1/status`，並以 `upsertLineMember` 取得非空 `memberId` 後才建立 8 小時 D1 session；解析失敗時 fail closed。`GET /api/auth/me` 回 `data.csrfToken`，登入後 mutation 必須傳 `X-CSRF-Token`。
4. cookie 固定 `__Host-`、`HttpOnly`、`Secure`。GitHub Pages → `workers.dev` 是 cross-site，需 `COOKIE_SAME_SITE=None`；正式環境強烈建議把 Worker 掛在網站同站 custom domain，改為 `Lax`。
5. webhook 對最多 2 MB 的原始 bytes 驗 `x-line-signature`。成功立即回 `200`，D1 僅保存最小必要事件欄位、狀態、嘗試次數與下次嘗試時間；首次轉送由 `ctx.waitUntil()` 執行，之後由每 5 分鐘 Cron 重試，最多 3 次。已成功事件保持去重，30 天後由排程清理；一般 JSON 上限 64 KB。

## 管理員導向

`ADMIN_DASHBOARD_URL` 是非機密設定，正式部署時必須填入已部署 Apps Script Web App 的 `/exec` URL。預設保留空字串，避免錯誤導向 GitHub Pages 的 live-mode admin redirect loop。`GET /api/config` 與成功的 `POST /api/auth/admin` 都會回 `adminDashboardUrl`；尚未設定時為 `null`，前端不得自動導向。

## Secrets 與設定

`wrangler.jsonc` 只有非機密預設值；部署前先換掉 D1 `database_id`、建立 R2 bucket，並用 `wrangler secret put` 設定：

```bash
npx wrangler secret put LINE_LOGIN_CHANNEL_ID --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_LOGIN_CALLBACK_URL --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_MESSAGING_CHANNEL_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put APPS_SCRIPT_URL --config cloudflare/wrangler.jsonc
npx wrangler secret put APPS_SCRIPT_SHARED_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_OA_BASIC_ID --config cloudflare/wrangler.jsonc
```

LINE Login session 永遠是 member；不得以 LINE user ID 升為 admin。管理員由 Apps Script 驗 Google allowlist 與 2FA 後，透過 `authenticateAdmin` 建立獨立 admin session。

請勿建立或提交 `.dev.vars`。本機測試 secrets 只存在 Vitest 的 Miniflare bindings。

## 建置、測試與部署

```bash
npx wrangler types cloudflare/src/worker-configuration.d.ts --config cloudflare/wrangler.jsonc
npx tsc -p cloudflare/tsconfig.json --noEmit
npx vitest run --config cloudflare/vitest.config.ts
npx wrangler d1 migrations apply zhifu-invest-gateway --remote --config cloudflare/wrangler.jsonc
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc
```

正式建立資源後，把 placeholder D1 UUID 換成實際 binding ID，再執行 migration 與部署。

`wrangler.jsonc` 已設定 `*/5 * * * *` Cron。部署後請在 Cloudflare Dashboard 確認 Cron Trigger 存在，並用一筆刻意失敗的測試 webhook 驗證 D1 狀態依序為 `retry`、`delivered` 或第三次後 `failed`。
