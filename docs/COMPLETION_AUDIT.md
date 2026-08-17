# 致富投資 MVP 完成度稽核

更新日：2026-08-18（Asia/Taipei）

這份文件刻意分開「程式已完成」、「本機已驗證」與「真實供應商已驗收」。沒有正式帳號或憑證時，不把模擬結果寫成 LINE、Google 或 Cloudflare 已上線。

## 已完成並有本機證據

| 範圍 | 結果 | 驗證方式 |
|---|---|---|
| Mobile-first 公開站、會員中心、營運儀表板 | 完成 | 390px 首頁、啟用、會員資料室／預約、後台預約、認購、引薦與分潤 Playwright journeys |
| 6 專案／30 會員／25 認購 Demo | 完成 | seed invariant tests；所有資料清楚標示 DEMO |
| 會員資料隔離與逐案權限 | 完成 | 兩個獨立 session E2E、API domain tests |
| 五種認購金額與獨立狀態 | 完成 | requested／approved／received／allocated／refunded invariant tests |
| 雪芬姐確認會員與認購 | 完成 | Docker admin E2E；Apps Script HtmlService 操作與 audit 寫入 |
| 多引薦方歸因與分潤 | 完成 | 有效來源碼只建立 claimed、管理員證據才 verified、認購不可變快照、final allocation 才 accrued、approve/pay/void 證據、paid/void 終態、會員 DTO 隔離；Node／Worker／Apps Script tests 與 390px E2E |
| LINE 通知政策 | 程式完成 | routine 自動、拒絕／退款／bulk 人工確認、首次失敗後再重試三次再轉待辦；未聲稱真實送達 |
| LINE Login／webhook gateway | 程式完成 | state／nonce、member resolution fail closed、raw body HMAC、D1 durable retry／去重／30 天清理、18 個 Workers tests |
| GitHub Pages runtime | 完成 | 未設 API 時唯讀；設 API 後 credentialed fetch、CSRF、禁止 Demo fallback |
| Pitch Deck | 程式完成 | R2 私有物件、5 分鐘同 session token、inline 串流、下載 audit |
| Apps Script／Sheets operations | 程式完成 | signed envelope、缺 member ID fail closed、同 project lock＋flush、Google allowlist＋TOTP、引薦／分潤 canonical schema、preflight／單一 trigger、23 個 VM tests |
| 會員資料室與顧問預約 | 程式完成 | 企業／團隊／資金用途／財務、已核准 AI／專家報告 metadata、會員與後台預約列表 |
| 本機 Docker | 已運行 | `http://127.0.0.1:4173` health、5-route smoke、6 Playwright journeys |

## 尚未完成的真實外部驗收

| 前置資料／權限 | 取得後要做的驗收 |
|---|---|
| 營運法律主體、正式網域、隱私／風險文字核定 | 自訂網域、cookie、正式頁尾與法律內容 |
| 正式 audit retention 要求 | Sheets 僅提供應用層追加式 audit；若要求 WORM／不可竄改保存，需配置外部 retention-locked store |
| 同一 LINE Provider 下的 Login 與 Messaging API channels | iOS／Android 登入、加好友、follow/unfollow webhook、實際 push 收件 |
| LINE Login secret、Messaging channel secret／access token、OA Basic ID | Worker secrets 與 Apps Script properties 注入；不得提交 GitHub |
| Cloudflare 帳號／zone | 建立 D1、R2、Worker custom domain，套用 migration，上傳測試 deck |
| 同一 Apps Script project 的 Gateway／Admin 兩個固定版本 deployments、共用 Sheet | Gateway HMAC 往返、兩管理員 Google allowlist＋各自 TOTP、time-driven notification trigger |
| 雪芬姐與至少一位備援管理員 Google 帳號 | allowlist、Google 兩步驟驗證、兩組 TOTP、管理員實機登入與到期／鎖定測試 |
| 至少兩個 LINE 測試會員 | 跨帳號隔離、資格／逐案授權、通知與短效文件測試 |
| 每位正式引薦方的法定名稱、窗口、協議、費率、有效期與付款流程 | 以測試會員完成 claimed → verified → immutable snapshot → final allocation → approve → pay，核對 CSV、audit 與付款證據；引薦方本身不得取得會員或認購資料 |

## 完成判定

程式與本機部署已達到「可交付並等待正式憑證」；整體 `/goal` 只有在 `PRODUCTION_DEPLOYMENT.md` 的 live acceptance 全部留下實機證據後，才可標記完成。
