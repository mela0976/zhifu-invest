# 致富投資 Apps Script／Google Sheets 營運套件

此目錄是正式架構中的營運資料層：Cloudflare Worker 透過簽名 `doPost`
存取 Sheets；雪芬姐使用 HtmlService 後台。它不在前端保存 secret，也不把
Sheets 直接公開給瀏覽器。

## 1. 建立與初始化

1. 建立一個新的 Apps Script 專案，將本目錄除 `tests/` 外的檔案上傳。
2. 執行 `setupWorkbook()`；它會建立或連結試算表、寫入 `SPREADSHEET_ID`，並建立：
   `Members`、`Projects`、`Subscriptions`、`Bookings`、`Activations`、
   `Notifications`、`Audits`、`GatewayNonces`。
3. 只有測試環境才手動執行 `seedDemoData()`。它不會自動執行，且只接受空白資料表；
   產生 6 個專案、30 位會員、25 筆認購，人物、公司與文字均標示 `DEMO`。
4. 在 Apps Script「專案設定 → 指令碼屬性」加入下列屬性，不要寫入 Git：

| Script Property | 用途 |
|---|---|
| `SPREADSHEET_ID` | `setupWorkbook()` 自動設定；兩個 Script 專案共用同一份 Sheet 時需複製 |
| `GATEWAY_SHARED_SECRET` | Worker 與 gateway 共用，至少 32 個隨機字元；對應 Worker `APPS_SCRIPT_SHARED_SECRET` |
| `ADMIN_EMAILS` | 可管理的 Google email，以逗號分隔；至少兩名管理者 |
| `GOOGLE_ADMIN_CLIENT_ID` | 前端 Google Identity Services 的 OAuth client ID |
| `ADMIN_TOTP_SECRETS_JSON` | email 到 Base32 TOTP secret 的 JSON，例如 `{"admin@example.com":"BASE32..."}` |
| `LINE_MESSAGING_ACCESS_TOKEN` | LINE OA Messaging API 長效 channel access token |
| `MEMBER_APP_BASE_URL` | 正式會員站 URL，通知只帶狀態文字與此深連結 |

管理帳號的 Google Workspace／Google Account 仍須強制啟用 Google 兩步驟驗證；
Worker 的管理登入另外驗證 `ADMIN_TOTP_SECRETS_JSON` TOTP，不以 LINE 身分升級成 admin。

## 2. 兩個 Web App 部署

Google Apps Script 的執行身分是 deployment 屬性：匿名 Worker gateway 需要
`USER_DEPLOYING`，而 `Session.getActiveUser().getEmail()` 的後台 allowlist 需要
`USER_ACCESSING`。因此正式環境使用兩個獨立 Apps Script 專案（共用同一份 Sheet、
部署相同 `.gs`/HTML）：

- **Gateway project**：使用 `appsscript.json`，`ANYONE_ANONYMOUS` +
  `USER_DEPLOYING`；URL 只交給 Worker 的 `APPS_SCRIPT_URL`。公開知道 URL 仍無法繞過
  HMAC、5 分鐘時窗與 nonce replay gate。
- **Admin project**：把 `appsscript.admin.json` 的內容作為該專案的
  `appsscript.json`，`ANYONE` + `USER_ACCESSING`；只把 URL 給管理者。
  `doGet` 與每一次 `adminRpc` 都重新檢查 `ADMIN_EMAILS`，未授權或無法取得 email 時拒絕。

這兩種執行模式與 access enum 是 Apps Script 官方 manifest 行為：
https://developers.google.com/apps-script/manifest/web-app-api-executable

為 `processNotificationQueue` 安裝每 5 分鐘執行的 time-driven trigger。Routine 事件會
自動排入 `queued`；拒絕、退款與 bulk 先停在 `pending_manual`。LINE 失敗以 5/10 分鐘
退避重試，第三次失敗成為 `failed` 待辦。訊息模板從不包含金額。

## 3. Worker → Apps Script 固定信封

`POST` body：

```json
{
  "timestamp": 1786982400000,
  "nonce": "base64url-random-at-least-16",
  "operation": "subscriptions.create",
  "payloadJson": "{\"requestId\":\"...\"}",
  "signature": "HMAC-SHA256-standard-base64"
}
```

`payloadJson` 必須只 `JSON.stringify` 一次。Canonical bytes 是 UTF-8：

```text
String(timestamp) + "\n" + nonce + "\n" + operation + "\n" + payloadJson
```

簽章使用標準 Base64（保留 `+`、`/`、`=`）。Apps Script 驗簽後，在同一個
`LockService.getScriptLock()` critical section 內完成 nonce 查重、業務驗證、寫入與
audit append。時間差超過 5 分鐘或 nonce 已使用都拒絕。

回應固定只有：

```json
{"ok":true,"data":{}}
```

或：

```json
{"ok":false,"error":{"code":"forbidden","message":"..."}}
```

Apps Script ContentService 無法可靠設定 HTTP status，因此 Worker 必須以 `ok` 判斷，
不可把 HTTP 200 本身當成成功。

## 4. Operation 契約

所有一般 proxy payload 由 Worker 產生：

```json
{
  "requestId":"uuid",
  "method":"POST",
  "path":"/api/subscriptions",
  "query":{},
  "params":{},
  "body":{},
  "idempotencyKey":"client-key",
  "actor":{"role":"member","memberId":"member-...","sessionId":"..."}
}
```

Apps Script 只相信簽名 envelope 內的 Worker `actor`；不使用瀏覽器 body 自稱的角色或會員 ID。

| Dotted operation（Worker 正式契約） | 主要 payload／response |
|---|---|
| `auth.line.resolve` | `{lineUserId,displayName,pictureUrl,friendshipStatus}` → `{memberId}`；新會員為 pending |
| `member.self` / `getMember` | Worker session context → 已遮蔽 LINE userId 的本人會員資料；供會員儀表板顯示資格與方案 |
| `auth.admin.authenticate` | `{googleCredential,twoFactorCode}` → `{adminId,displayName}`；驗 Google token audience/email/expiry、allowlist、TOTP |
| `projects.list` | proxy payload → `{projects}`；未逐案授權時只有 public view |
| `projects.get` | `params.projectId` → `{project}`；同樣做逐案欄位遮罩 |
| `activation.create` | `body:{fullName,phone,sourceCode,sourceName,lineFriendConfirmed,privacyConsent}` → `{activation}`；memberId 與 LINE userId 一律取可信 session context |
| `bookings.list` | member/admin → `{bookings}`，會員只見自己的資料 |
| `bookings.create` | `body:{displayName,phone,email,advisorType,topic,preferredTime,note}` → `{booking}` |
| `subscriptions.list` | member/admin → `{subscriptions}`，會員只見自己的資料 |
| `subscriptions.create` | `body:{projectId,requestedAmountTwd}` + `idempotencyKey` → `{subscription,replayed}`；檢查 active、qualification approved、逐案權限與 minimum/increment |
| `deck.authorize` | `{projectId,actor}` → `{allowed,objectKey,filename,contentType,expiresAt}`；R2 key 來自 `project.deck.objectKey`，缺省為 `decks/{projectId}/{deckId}.pdf` |
| `deck.download.audit` | `{projectId,objectKey,actor,downloadedAt}` → `{accepted:true}` |
| `line.webhook.ingest` | `{events:[minimal LINE events]}` → `{accepted,results}`；只存 event metadata，不保存訊息全文 |
| `admin.dashboard`, `admin.overview` | → KPI、五種金額總計、近期認購與待辦 |
| `admin.members.list`, `admin.projects.list`, `admin.subscriptions.list`, `admin.notifications.list`, `admin.audits.list` | → `{resource,records,total}` |
| `admin.actions.list` | → `{actions:{members,subscriptions,notifications}}` |
| `admin.members.update` | `params.memberId`, `body` patch + reason；資格 approved 必須有 approver/date/reference |
| `admin.projects.update` | `params.projectId`, `body` patch + reason；逐案 allowlist 寫入 Projects |
| `admin.subscriptions.update` | `params.subscriptionId`, `body` patch + reason；五金額 invariant、狀態 transition、partner evidence |
| `admin.notifications.create` | `body:{memberIds,announcementId}`；建立 bulk `pending_manual` |
| `admin.notifications.send` | `params.notificationId`, `body.reason`；人工核准後進 `queued` |
| `admin.exports.members`, `admin.exports.subscriptions` | → `{filename,mimeType,csv}`；每次匯出都 append audit |

為 HtmlService 與向下相容，也支援 camelCase：`upsertLineMember`、`getMember`、`listProjects`、
`getProject`、`listSubscriptions`、`createBooking`、`createActivation`、
`createSubscription`、`authorizeDeck`、`webhookEvent`、`adminDashboard`、`adminList`、
`adminPatchMember`、`adminPatchProject`、`adminPatchSubscription`、
`adminApproveNotification`、`adminCreateBulkNotification`、
`adminProcessNotifications`、`adminExport`、`authenticateAdmin`、`deckDownloadAudit`。

## 5. 資料與合規規則

- `Subscriptions` 有獨立 `membershipState`、`qualificationState`、
  `subscriptionState`、`fundingState`、`allocationState`，並有 requested／approved／
  received／allocated／refunded 五個整數 TWD ledger。
- approved 不得高於 requested、received 不得高於 approved、refunded 不得高於
  received、allocated 不得高於 received-refunded。
- 認購或合格投資人核准均必須保存持牌合作機構 approver、approvedAt、reference。
- protected project 只有 active + qualification approved + member projectAccess 或 project
  memberAllowlist 才返回；visitor/member 無權時不回傳 company、amount、reports、deck。
- `Audits` 只 append；包含 actor、before/after、reason、requestId、時間。不要手動編輯或刪除。

## 6. 驗證

```bash
node apps-script/tests/run-tests.cjs
```

測試涵蓋獨立 HMAC canonical/signature vector、過期與篡改、五金額 invariant、狀態與
partner evidence、角色/逐案欄位遮罩、通知自動/人工政策及無金額訊息。真實 Google／LINE／
Sheets/R2 驗收仍需正式 credentials 與測試帳號，不能用此純函式測試代替。
