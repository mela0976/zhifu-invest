# 致富投資 Apps Script／Google Sheets 營運套件

此目錄是正式架構中的營運資料層：Cloudflare Worker 透過簽名 `doPost`
存取 Sheets；引薦人使用 HtmlService 後台。它不在前端保存 secret，也不把
Sheets 直接公開給瀏覽器。

## 1. 建立與初始化

1. 建立一個新的 Apps Script 專案，將本目錄除 `tests/` 外的檔案上傳。
2. 執行 `setupWorkbook()`；它會建立或連結試算表、寫入 `SPREADSHEET_ID`，並建立：
   `Members`、`Projects`、`Subscriptions`、`Referrers`、`Bookings`、`Activations`、
   `Notifications`、`Audits`、`GatewayNonces`。
3. 只有測試環境才手動執行 `seedDemoData()`。它不會自動執行，且只接受空白資料表；
   產生 6 個專案、30 位會員、25 筆認購，人物、公司與文字均標示 `DEMO`。
4. 在 Apps Script「專案設定 → 指令碼屬性」加入下列屬性，不要寫入 Git：

| Script Property | 用途 |
|---|---|
| `SPREADSHEET_ID` | `setupWorkbook()` 自動設定；gateway／admin 兩個 deployment 共享同一份設定 |
| `GATEWAY_SHARED_SECRET` | Worker 與 gateway 共用，至少 32 個隨機字元；對應 Worker `APPS_SCRIPT_SHARED_SECRET` |
| `ADMIN_EMAILS` | 可管理的 Google email，以逗號分隔；至少兩名管理者 |
| `GOOGLE_ADMIN_CLIENT_ID` | 前端 Google Identity Services 的 OAuth client ID |
| `ADMIN_TOTP_SECRETS_JSON` | email 到 Base32 TOTP secret 的 JSON，例如 `{"admin@example.com":"BASE32..."}` |
| `LINE_MESSAGING_ACCESS_TOKEN` | LINE OA Messaging API 長效 channel access token |
| `MEMBER_APP_BASE_URL` | 正式會員站 URL，通知只帶狀態文字與此深連結 |

管理帳號的 Google Workspace／Google Account 仍須強制啟用 Google 兩步驟驗證；
Worker 與 HtmlService 管理登入都另外驗證 `ADMIN_TOTP_SECRETS_JSON` TOTP，不以 LINE 身分
升級成 admin。email key 請使用小寫，且每個 `ADMIN_EMAILS` 帳號都必須有獨立 Base32 secret。
`ADMIN_AUTH_STATES_JSON` 與 User Property `ADMIN_HTML_SESSION_JSON` 是程式運行時資料，不要手動建立或修改。

完成屬性設定後，手動執行 `validateDeploymentConfiguration()`。它會 fail closed 檢查至少兩名
不重複管理員、每人 TOTP、gateway secret 與 spreadsheet 設定，回傳值不含任何 secret。

## 2. 同一 Script project 的兩個 Web App deployment

Google Apps Script 的執行身分是 deployment 屬性：匿名 Worker gateway 需要
`USER_DEPLOYING`，而 `Session.getActiveUser().getEmail()` 的後台 allowlist 需要
`USER_ACCESSING`。正式環境必須使用**同一個 Apps Script project、兩個固定版本 deployment**；
不要複製成兩個 Script project。如此 nonce、Sheets 寫入、TOTP replay counter 與 audit 才會共享
同一組 Script Properties 與 `LockService.getScriptLock()`。

建議的版本流程：

1. 以 `appsscript.json` 建立 gateway 版本，建立 Web App deployment A：
   `ANYONE_ANONYMOUS` + `USER_DEPLOYING`。A 的 URL 只交給 Worker `APPS_SCRIPT_URL`；公開知道
   URL 仍無法繞過 HMAC、5 分鐘時窗與 nonce replay gate。
2. 在**相同 Script ID** 暫時將 `appsscript.admin.json` 內容作為 manifest，建立另一個 immutable
   版本，再建立 Web App deployment B：`ANYONE` + `USER_ACCESSING`。B 的 URL 只給管理者。
3. 後續每次發版都各建立一個 gateway version 與 admin version，再分別更新 A、B 所指版本；
   不要讓正式 deployment 指向 Head，也不要刪除仍被 deployment 使用的版本。

`doGet` 先檢查目前 Google email 與至少兩人的 `ADMIN_EMAILS` preflight。通過後仍只顯示 TOTP
gate；驗證成功才核發 8 小時 session。原始 token 只存在瀏覽器 `sessionStorage`（關閉分頁即清除），
User Properties 僅保存 token SHA-256 雜湊與到期時間。每次 `adminRpc` 都重新驗 Google allowlist、
token 雜湊與期限；同一 TOTP counter 不可重播，10 分鐘內連錯 5 次會鎖 15 分鐘。

這兩種執行模式與 access enum 是 Apps Script 官方 manifest 行為：
https://developers.google.com/apps-script/manifest/web-app-api-executable

先執行 `productionPreflight()`，再執行一次 `installNotificationQueueTrigger()`，以冪等方式
為 `processNotificationQueue` 安裝唯一一個每 5 分鐘執行的 time-driven trigger。Routine 事件會
自動排入 `queued`；拒絕、退款與 bulk 先停在 `pending_manual`。LINE 失敗以 5/10 分鐘
再加 15 分鐘退避，亦即首次投遞後最多重試三次；第四次失敗成為 `failed` 待辦。訊息模板
從不包含金額。

所有 Sheets mutation 都在同一 ScriptLock 內執行，並在 release lock 前呼叫
`SpreadsheetApp.flush()`。若已存在舊版 Sheet，新增欄位不會被靜默改寫；`setupWorkbook()` 會以
`schema_mismatch` 拒絕。先備份，再由 allowlist 管理員手動執行一次
`migrateReferralCommissionSchema()`；它只接受舊版表頭的精確前綴、append 新欄並建立
`Referrers`，遇到其他差異即 fail closed。

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

| Operation（dotted alias；camelCase 同樣支援） | 主要 payload／response |
|---|---|
| `auth.line.resolve` | `{lineUserId,displayName,pictureUrl,friendshipStatus}` → `{memberId}`；新會員為 pending |
| `member.self` / `getMember` | Worker session context → 已遮蔽 LINE userId 的本人會員資料；供會員儀表板顯示資格與方案 |
| `auth.admin.authenticate` | `{googleCredential,twoFactorCode}` → `{adminId,displayName}`；驗 Google token audience/email/expiry、allowlist、TOTP |
| `projects.list` | proxy payload → `{projects}`；未逐案授權時只有 public view |
| `projects.get` | `params.projectId` → `{project}`；同樣做逐案欄位遮罩 |
| `activation.create` | `body:{fullName,phone,sourceCode,sourceName,lineFriendConfirmed,privacyConsent}` → `{activation}`；memberId 與 LINE userId 一律取可信 session context，並以伺服器保存的 `member.lineFriendshipState=friend` 為準，checkbox 不能當好友證據 |
| `bookings.list` | member/admin → `{bookings}`，會員只見自己的資料 |
| `bookings.create` | `body:{displayName,phone,email,advisorType,topic,preferredTime,note}` → `{booking}` |
| `subscriptions.list` | member/admin → `{subscriptions}`，會員只見自己的資料 |
| `subscriptions.create` | `body:{projectId,requestedAmountTwd,riskAcknowledged:true}` + `idempotencyKey` → `{subscription,replayed}`；檢查 active、qualification approved、逐案權限與 minimum/increment，並保存風險版本與確認時間 |
| `deck.authorize` | `{projectId,actor}` → `{allowed,objectKey,filename,contentType,expiresAt}`；R2 key 來自 `project.deck.objectKey`，缺省為 `decks/{projectId}/{deckId}.pdf` |
| `deck.download.audit` | `{projectId,objectKey,actor,downloadedAt}` → `{accepted:true}` |
| `line.webhook.ingest` | `{events:[minimal LINE events]}` → `{accepted,results}`；只存 event metadata，不保存訊息全文 |
| `admin.dashboard`, `admin.overview` | → `{overview,kpis,referrers,members,subscriptions,commissions,actions}`，另保留 HtmlService 使用的近期認購與待辦 alias |
| `admin.members.list`, `admin.projects.list`, `admin.subscriptions.list`, `admin.notifications.list`, `admin.audits.list` | → `{resource,records,total}` |
| `admin.actions.list` | → `{actions:{members,subscriptions,notifications}}` |
| `admin.members.update` | `params.memberId`, `body` patch + reason；資格 approved 必須有 approver/approvedAt/reference/future expiresAt，並可更新 `projectAccess[]` |
| `admin.projects.update` | `params.projectId`, `body` patch + reason；逐案 allowlist 寫入 Projects |
| `admin.subscriptions.update` | `params.subscriptionId`, `body` patch + reason；五金額 invariant、狀態 transition、partner evidence |
| `adminCreateReferrer` | `{referrer:{code,displayName,legalName,contactName,contactEmail,status,defaultCommissionRateBps,commissionBasis,agreementReference,effectiveAt,expiresAt},reason}` → `{referrer}`；`commissionBasis` 固定為 `allocated_amount`，code 全站唯一 |
| `adminPatchReferrer` | `{referrerId,patch:{code?,displayName?,legalName?,contactName?,contactEmail?,status?,defaultCommissionRateBps?,commissionBasis?,agreementReference?,effectiveAt?,expiresAt?},reason}` → `{referrer}`；變更 code 會重新正規化並檢查唯一性 |
| `adminPatchCommission` | `{subscriptionId,action,approvalReference?,payoutReference?,voidReason?,reason}` → `{commission}`；action 只接受 `approve`、`pay`、`void` |
| `admin.notifications.create` | `body:{memberIds,announcementId}`；建立 bulk `pending_manual` |
| `admin.notifications.send` | `params.notificationId`, `body.reason`；人工核准後進 `queued` |
| `admin.exports.members`, `admin.exports.subscriptions`, `adminExport(resource=referrers|commissions)` | → `{filename,mimeType,csv}`；每次匯出都 append audit |

為 HtmlService 與向下相容，也支援 camelCase：`upsertLineMember`、`getMember`、`listProjects`、
`getProject`、`listSubscriptions`、`createBooking`、`createActivation`、
`createSubscription`、`authorizeDeck`、`webhookEvent`、`adminDashboard`、`adminList`、
`adminPatchMember`、`adminPatchProject`、`adminPatchSubscription`、
`adminCreateReferrer`、`adminPatchReferrer`、`adminPatchCommission`、
`adminApproveNotification`、`adminCreateBulkNotification`、
`adminProcessNotifications`、`adminExport`、`authenticateAdmin`、`deckDownloadAudit`。

## 5. 資料與合規規則

- `Subscriptions` 有獨立 `membershipState`、`qualificationState`、
  `subscriptionState`、`fundingState`、`allocationState`，並有 requested／approved／
  received／allocated／refunded 五個整數 TWD ledger。
- 每筆新認購必須保存 `riskAcknowledged=true`、`riskAcknowledgedAt` 與
  `riskDisclosureVersion`；前端勾選但後端未留證不算完成。
- approved 不得高於 requested、received 不得高於 approved、refunded 不得高於
  received、allocated 不得高於 received-refunded。
- 認購核准必須保存持牌合作機構 approver、approvedAt、reference。合格投資人核准另需未過期的
  expiresAt；approvedAt 必須可解析、不得明顯晚於伺服器時間，且 expiresAt 必須晚於 approvedAt。
- protected project 只有 active + qualification approved + member projectAccess 或 project
  memberAllowlist 且資格未過期才返回；visitor/member 無權時不回傳 company、amount、reports、deck。
- 啟用申請保存 sourceCode、sourceName、consentedAt 與當時伺服器已驗證的 LINE friendship evidence；
  後台會一併顯示，讓引薦人確認來源與同意證據。
- `sourceCode` 只有在對應 `active` 且生效中的 Referrer 時，才建立單一
  `Members.referralAttributionJson` claimed object；未知、disabled 或過期 code 不建立 claim，也不會清除既有 verified 歸因。
  管理員必須以 `{referrerId,evidenceReference}` 提供證據，才可把歸因設為 `verified`。
- 認購建立時只快照「verified 且 Referrer 在 `effectiveAt <= capturedAt < expiresAt` 生效」的引薦方。
  `Subscriptions.referralSnapshotJson` 固定 `referrerId,referrerName,referralCode,commissionRateBps,commissionBasis,agreementReference,capturedAt`，
  後續修改 Referrer 不回寫歷史認購。
- 分潤固定為 `floor(allocatedAmountTwd * commissionRateBps / 10000)`。有快照的認購先為 `pending`，
  只有 final allocation 且配置金額大於 0 才成為 `accrued`。approve 必須有
  `approvalReference`，pay 必須先 approved 且有 `payoutReference`，void 必須有 `voidReason`；三者都
  必須另有操作 `reason` 並 append audit。approved／paid 鎖定分潤金額；void 凍結分潤基礎與金額，
  但認購 ledger 仍可依合法狀態轉移繼續更新。paid 與 void 都是分潤終態。
- 會員 DTO 與認購會員 DTO 不回 `commission*`、`referralSnapshot`、`referralAttribution`、
  `evidenceReference` 或 `referrerName`；完整引薦與分潤資料只允許 admin operation。
- `Audits` 在應用層只 append；包含 actor、before/after、reason、requestId、時間。不要手動編輯或刪除。Google Sheets 本身不是 WORM storage；若正式法規要求不可竄改保存，需另接有 retention lock 的 audit store。

## 6. 驗證

```bash
node apps-script/tests/run-tests.cjs
```

測試涵蓋獨立 HMAC canonical/signature vector、過期與篡改、lock 內 flush、五金額 invariant、
推導狀態不可倒退、partner/qualification evidence 時序、缺 memberId fail closed、過期資格、
伺服器 LINE 好友證據、TOTP replay／lockout／session 雜湊與到期、兩管理員 preflight、逐案欄位
遮罩、claimed/verified/effective referral、分潤狀態與 paid immutable、會員序列化隔離、
通知自動/人工政策及無金額訊息。真實 Google／LINE／Sheets/R2 驗收仍需正式 credentials
與測試帳號，不能用此純函式測試代替。
