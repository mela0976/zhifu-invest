# 致富投資 MVP 完成度稽核

更新日：2026-08-18（Asia/Taipei）

這份文件刻意分開「程式已完成」、「本機已驗證」與「真實供應商已驗收」。沒有正式帳號或憑證時，不把模擬結果寫成 LINE、Google 或 Cloudflare 已上線。

## 已完成並有本機證據

| 範圍 | 結果 | 驗證方式 |
|---|---|---|
| Mobile-first 公開站、會員中心、雪芬姐儀表板 | 完成 | 390px Playwright journey、水平溢位與主要操作檢查 |
| 6 專案／30 會員／25 認購 Demo | 完成 | seed invariant tests；所有資料清楚標示 DEMO |
| 會員資料隔離與逐案權限 | 完成 | 兩個獨立 session E2E、API domain tests |
| 五種認購金額與獨立狀態 | 完成 | requested／approved／received／allocated／refunded invariant tests |
| 雪芬姐確認會員與認購 | 完成 | Docker admin E2E；Apps Script HtmlService 操作與 audit 寫入 |
| LINE 通知政策 | 程式完成 | routine 自動、拒絕／退款／bulk 人工確認、三次失敗轉待辦；未聲稱真實送達 |
| LINE Login／webhook gateway | 程式完成 | state／nonce、官方 token verify 流程、raw body HMAC、D1 去重、Workers tests |
| GitHub Pages runtime | 完成 | 未設 API 時唯讀；設 API 後 credentialed fetch、CSRF、禁止 Demo fallback |
| Pitch Deck | 程式完成 | R2 私有物件、5 分鐘同 session token、inline 串流、下載 audit |
| Apps Script／Sheets operations | 程式完成 | signed envelope、5 分鐘 replay window、LockService、八張 Sheet、VM tests |
| 本機 Docker | 已運行 | `http://127.0.0.1:4173` health、5-route smoke、4 Playwright journeys |

## 尚未完成的真實外部驗收

| 前置資料／權限 | 取得後要做的驗收 |
|---|---|
| 營運法律主體、正式網域、隱私／風險文字核定 | 自訂網域、cookie、正式頁尾與法律內容 |
| 同一 LINE Provider 下的 Login 與 Messaging API channels | iOS／Android 登入、加好友、follow/unfollow webhook、實際 push 收件 |
| LINE Login secret、Messaging channel secret／access token、OA Basic ID | Worker secrets 與 Apps Script properties 注入；不得提交 GitHub |
| Cloudflare 帳號／zone | 建立 D1、R2、Worker custom domain，套用 migration，上傳測試 deck |
| 兩個 Apps Script deployments、共用 Sheet | Gateway HMAC 往返、Admin Google allowlist、time-driven notification trigger |
| 雪芬姐與至少一位備援管理員 Google 帳號 | allowlist、Google 兩步驟驗證、管理員實機登入 |
| 至少兩個 LINE 測試會員 | 跨帳號隔離、資格／逐案授權、通知與短效文件測試 |

## 完成判定

程式與本機部署已達到「可交付並等待正式憑證」；整體 `/goal` 只有在 `PRODUCTION_DEPLOYMENT.md` 的 live acceptance 全部留下實機證據後，才可標記完成。
