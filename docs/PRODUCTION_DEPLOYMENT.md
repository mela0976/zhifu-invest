# 致富投資正式部署 Runbook

> 狀態：部署就緒草案。未填入營運帳號、網域與密鑰前，不代表正式 LINE 或會員資料服務已上線。

## 1. 資源所有權

所有正式資源應由實際營運法律主體持有，至少配置兩位管理員：

- LINE Developers Provider、LINE Login channel、Messaging API channel
- Cloudflare zone、Worker、D1、R2
- Google Spreadsheet、Apps Script project 與 deployment
- GitHub repository 與 Pages environment

LINE Login 與 Messaging API channel 必須位於同一個 LINE Provider。LINE 群組與 OpenChat 僅作導流來源，不作會員身分資料庫；會員主鍵來自後端驗證後的 LINE `sub`／user ID。

## 2. 網域與瀏覽器 session

建議使用同一個自訂網域：

| 介面 | 範例 |
|---|---|
| GitHub Pages | `https://www.YOUR_DOMAIN/` |
| Cloudflare Worker | `https://api.YOUR_DOMAIN/` |
| LINE callback | `https://api.YOUR_DOMAIN/api/auth/line/callback` |
| LINE webhook | `https://api.YOUR_DOMAIN/api/line/webhook` |

`github.io` 搭配 `workers.dev` 會形成跨站 cookie；部分 Safari／隱私模式可能封鎖。正式會員流程應以同站子網域驗收，且 callback URL 必須與 LINE Console 完全一致。

## 3. LINE 設定

1. 在同一 Provider 建立 LINE Login 與 Messaging API channel。
2. Login scope 使用 `openid profile`，authorization request 帶隨機 `state` 與 `nonce`。
3. 連結官方帳號並開啟登入時加好友提示。
4. 將 callback 與 webhook 設成上節的 HTTPS URL。
5. Webhook 必須先驗 `x-line-signature` 對原始 body 的 HMAC-SHA256，再 parse JSON。
6. 通知只寫「狀態已更新，請登入查看」，不包含姓名、認購、入金、分配或退款金額。

完成 token 與 webhook 設定後，執行唯讀預檢。命令列只放可公開的 OA Basic ID；access token 由 TTY 隱藏提示讀取，不會發送訊息或變更 LINE 設定：

```bash
LINE_MESSAGING_EXPECTED_BASIC_ID='@YOUR_BASIC_ID' npm run preflight:line
```

預檢只呼叫 LINE 的 `GET /v2/bot/info` 與 `GET /v2/bot/channel/webhook/endpoint`，並要求 token 所屬 OA、webhook URL 與啟用狀態全部符合。若 OA 不符，會在查詢 webhook 前停止；輸出不包含 token、LINE 原始錯誤 body 或 webhook query/fragment。[Get bot info and webhook endpoint](https://developers.line.biz/en/reference/messaging-api/)

參考：[LINE Login web integration](https://developers.line.biz/en/docs/line-login/integrate-line-login/)、[LINE Login API](https://developers.line.biz/en/reference/line-login/)、[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)。

## 4. Cloudflare Worker

先登入並建立正式資源：

```bash
npx wrangler login
npx wrangler d1 create zhifu-invest-production
npx wrangler r2 bucket create zhifu-invest-decks-production
```

將建立後的 D1 database ID 與 R2 bucket name 填入 `cloudflare/wrangler.jsonc`，再把非機密的網域／cookie vars 改成正式值，然後：

```bash
npx wrangler d1 migrations apply zhifu-invest-gateway --remote --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_LOGIN_CHANNEL_ID --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_LOGIN_CALLBACK_URL --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_MESSAGING_CHANNEL_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put APPS_SCRIPT_URL --config cloudflare/wrangler.jsonc
npx wrangler secret put APPS_SCRIPT_SHARED_SECRET --config cloudflare/wrangler.jsonc
npx wrangler secret put LINE_OA_BASIC_ID --config cloudflare/wrangler.jsonc
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

網域、允許 origin 與 `COOKIE_SAME_SITE` 放 Wrangler vars；channel secret、access token 或 shared secret 絕不得提交 GitHub。上述其他值雖可公開，仍以 `wrangler secret put` 注入，避免直接修改 repo。Worker 使用 D1 保存一次性 OAuth state、8 小時 session、5 分鐘 deck token 與 webhook event ID；Pitch Deck 由 R2 binding 串流回傳。

把 `ADMIN_DASHBOARD_URL` 設成下節 Admin deployment 的正式 `/exec` HTTPS URL；未設定時正式 Pages 後台會 fail closed。Worker 的 Cron 每 5 分鐘重試尚未送達 Apps Script 的 LINE webhook，最多 3 次並保留 30 天狀態。

Cloudflare 建議新 Worker 使用目前 compatibility date、生成 binding types、以 bindings 存取平台資源並將非同步 webhook 工作交給 `ctx.waitUntil()`；本專案依此配置。[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 5. Apps Script 與 Google Sheets

1. 由營運 Google 帳號建立一份空白 Spreadsheet，以及**一個** standalone Apps Script project；所有 `apps-script/` 原始碼與 Script Properties 只維護一份。
2. 執行一次 `setupWorkbook()`，設定 `GATEWAY_SHARED_SECRET`、`LINE_MESSAGING_ACCESS_TOKEN`、`MEMBER_APP_BASE_URL`、至少兩人的 `ADMIN_EMAILS` 與每人不同的 `ADMIN_TOTP_SECRETS_JSON`。
3. 在同一 project 建立 Gateway 固定版本 deployment：`USER_DEPLOYING`／`ANYONE_ANONYMOUS`。URL 只交給 Worker，所有請求仍須通過 signed envelope。
4. 由同一 project 的另一個固定版本建立 Admin deployment：`USER_ACCESSING`／`ANYONE`。不要使用 Head deployment；兩個 entry point 共享 ScriptLock、nonce、TOTP replay counter、Sheet 與 audit。
5. 引薦人與備援管理員先通過 Google `ADMIN_EMAILS`，再輸入自有 TOTP；8 小時後台 session 的原始 token 只在該分頁的 `sessionStorage`，伺服器只存雜湊與期限。Google 帳號本身也必須開啟兩步驟驗證。
6. 執行 `productionPreflight()`，確認兩名管理員、每人 TOTP、gateway secret、spreadsheet、Email quota 與會員入口設定均存在；安裝唯一一個 `processNotificationQueue` 5 分鐘 trigger，以及唯一一個每日摘要 trigger。摘要日期由程式以 `Asia/Taipei` 計算，trigger 的實際分鐘可能由 Google 略作調整。
7. GitHub Pages 的 `admin.html` 僅供本機 Demo；正式引薦人儀表板由 Worker 的 `ADMIN_DASHBOARD_URL` 導向 Admin Apps Script `/exec`。
8. 執行 `migrateReferralCommissionSchema()`，建立 Referrers sheet 及會員／認購的歸因與分潤欄位；舊認購不得推測或回填歷史引薦證據。
9. 依 `apps-script/GROWTH-MIGRATION.md` 執行 growth schema migration，建立 Prospects、ContentItems、NewsletterPreferences、DailyDigests，並追加 member preference 與 subscription acquisition snapshot 欄位。migration 只補 schema，不回填虛構 Lead 歷史。
10. production 不執行 `seedDemoData()`；完整 deployment 操作與 manifest 切換方式見 `apps-script/README.md`。

### 正式引薦方上線資料

每位合作方在開放來源碼前，必須由 operations 建立：唯一 code、顯示名稱、簽約法定名稱、聯絡人／信箱、合作狀態、整數 basis points、`allocated_amount` 計算基礎、協議參考編號、生效與到期時間。來源碼只建立 claimed；會員歸因需管理員附引薦證據後才成為 verified。

認購送出時會複製不可變的 referrer／費率／協議快照。只有 final allocation 會進入 accrued；approve、pay、void 各自要求原因及證據，paid 不可逆。這是營運台帳，不等同法律上的報酬請求權；正式契約、適法性、稅務與付款由營運法律主體、持牌合作方及專業顧問確認。

Apps Script `doPost(e)` 只提供 request body 等 event fields，沒有可依賴的自訂 request header，因此 Worker 簽章放在 JSON body；所有 Sheet 寫入使用同一 project 的 `LockService.getScriptLock()`，並在釋放前 `SpreadsheetApp.flush()`。[Apps Script Web Apps](https://developers.google.com/apps-script/guides/web)、[deployment entry point](https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments)、[LockService](https://developers.google.com/apps-script/reference/lock/lock-service)

## 6. GitHub Pages

在 repository Actions variables 設定：

```text
PUBLIC_API_BASE_URL=https://api.YOUR_DOMAIN
```

Pages build 只把這個公開 API origin 寫入 `runtime-config.js`。沒有設定時，網站維持唯讀 Demo；設定後受保護頁不得回退至假會員或假後台資料。

## 7. 上線順序

1. 法律主體、隱私／風險文字、官方聯絡窗口核定。
2. Sheets schema 與 Apps Script gateway 部署。
3. D1 migration、R2 私有檔案、Worker secrets 與 custom domain。
4. LINE callback／webhook 設定與 Verify 測試。
5. Pages `PUBLIC_API_BASE_URL` 設定並重新部署。
6. 以測試會員完成 live acceptance；通過前維持 Demo 標示。

## 8. Live acceptance evidence

每一格均需保存時間、裝置、LINE request ID／audit ID 與預期結果：

- LINE iOS、LINE Android：首次登入、已授權、拒絕、取消、回訪、封鎖／解除封鎖 OA。
- Safari iOS／macOS、Chrome Android／Desktop、Edge：callback、cookie、deep link 回原頁、私密模式與網路錯誤。
- 一般群組與 OpenChat 導流：自助登入、加 OA、提交來源、引薦人人工確認；不得宣稱自動匯入群組名單。
- 兩位會員平行登入：專案、認購、文件與金額互不可見。
- 兩位管理員：Google allowlist、各自 TOTP、錯誤鎖定、登出與 8 小時到期；任何一人不得共用另一人的 TOTP。
- 合格投資人＋逐案 allowlist：未通過任一層不得取得保護 payload 或 R2 key。
- 認購：申請、營運確認、合作方核准、入金、分配、退款五組狀態／金額與 audit。
- 引薦與分潤：至少兩位引薦方、有效／未知／過期 code、claimed／verified、改派只影響未來認購、快照不回寫、final allocation 計提、核准／付款／作廢證據、paid 不可逆、會員端無分潤欄位。
- 潛客名單：以同批次來源證據匯入至少兩筆、phone/email 格式化重複、第二導入者衝突、會員綁定、合作到期後業績仍歸屬但不產生新分潤，並核對 `lead-export-v1`。
- 內容與媒合：draft／未來發布／缺風險提示不得公開；qualified 專案更新需逐案權限；未發布、撤回、關閉與截止專案不得出現在媒合。
- 每日摘要：站內五金額固定可讀；LINE／Email 分別 opt-in、撤回、同日重跑、Email quota 延後續送；外部訊息不含姓名、會員編號或金額，並以真實收件匣／LINE read-back 證明送達。
- LINE：例行通知自動送達；拒絕、退款、bulk 人工確認；失敗重試 3 次後進待辦。
- Pitch Deck：5 分鐘到期、同 session、個人化／稽核；LINE in-app browser 使用 inline／另開瀏覽器，不依賴 `download` attribute。
- 關閉帳戶：非必要資料刪除或去識別，法定認購與稽核紀錄封存。

只有上述真實 provider 測試完成，才可把「LINE 已串接」與整體 goal 標記完成。
