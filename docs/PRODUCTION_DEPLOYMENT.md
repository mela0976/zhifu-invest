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

Cloudflare 建議新 Worker 使用目前 compatibility date、生成 binding types、以 bindings 存取平台資源並將非同步 webhook 工作交給 `ctx.waitUntil()`；本專案依此配置。[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## 5. Apps Script 與 Google Sheets

1. 由營運 Google 帳號建立一份空白 Spreadsheet，以及 Gateway／Admin 兩個 standalone Apps Script project。
2. 兩個 project 都加入 `apps-script/` 原始碼；先在 Gateway project 執行一次 `setupWorkbook()`，再把同一 `SPREADSHEET_ID` 複製到 Admin project。
3. Gateway Script Properties 設定 `GATEWAY_SHARED_SECRET`、`LINE_MESSAGING_ACCESS_TOKEN`、`MEMBER_APP_BASE_URL`；Admin project 設定 `ADMIN_EMAILS`。若啟用 Worker 管理登入，再設定 `GOOGLE_ADMIN_CLIENT_ID` 與 `ADMIN_TOTP_SECRETS_JSON`。
4. Gateway deployment 採 `USER_DEPLOYING`／`ANYONE_ANONYMOUS`，URL 只交給 Worker，所有請求仍須通過 signed envelope。
5. 雪芬姐 Admin deployment 採 `USER_ACCESSING`／`ANYONE`，每次 `doGet` 與 `adminRpc` 都檢查 `ADMIN_EMAILS`；Google 帳號必須由帳號／Workspace 政策開啟兩步驟驗證。
6. GitHub Pages 的 `admin.html` 僅供本機 Demo；正式雪芬姐儀表板使用 Admin Apps Script deployment URL。
7. production 不執行 `seedDemoData()`。

Apps Script `doPost(e)` 只提供 request body 等 event fields，沒有可依賴的自訂 request header，因此 Worker 簽章放在 JSON body；所有 Sheet 寫入使用 `LockService.getScriptLock()` 防止同時確認覆蓋。[Apps Script Web Apps](https://developers.google.com/apps-script/guides/web)、[LockService](https://developers.google.com/apps-script/reference/lock/lock-service)

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
- 一般群組與 OpenChat 導流：自助登入、加 OA、提交來源、雪芬姐人工確認；不得宣稱自動匯入群組名單。
- 兩位會員平行登入：專案、認購、文件與金額互不可見。
- 合格投資人＋逐案 allowlist：未通過任一層不得取得保護 payload 或 R2 key。
- 認購：申請、營運確認、合作方核准、入金、分配、退款五組狀態／金額與 audit。
- LINE：例行通知自動送達；拒絕、退款、bulk 人工確認；失敗重試 3 次後進待辦。
- Pitch Deck：5 分鐘到期、同 session、個人化／稽核；LINE in-app browser 使用 inline／另開瀏覽器，不依賴 `download` attribute。
- 關閉帳戶：非必要資料刪除或去識別，法定認購與稽核紀錄封存。

只有上述真實 provider 測試完成，才可把「LINE 已串接」與整體 goal 標記完成。
