# 名單、內容與每日摘要 migration runbook

## 變更內容

此 migration 是 append-only：

- `Members` 尾端新增 `investmentPreferencesJson`、`leadOwnerAttributionJson`；名單連結後的首次有效 owner 不可變更。
- `Subscriptions` 尾端新增 `acquisitionAttributionSnapshotJson`；既有 `referralSnapshotJson` 仍只用於分潤。
- `Bookings` 尾端新增 `preferredDate`、`identityType`、`consentAt`。
- `Projects` 尾端新增 `status`、`publishedAt`、`withdrawnAt`，用於內容與媒合的生命週期 gate。
- 新增 `Prospects`、`ContentItems`、`NewsletterPreferences`、`DailyDigests` 四張 Sheet。
- `Prospects` 尾端新增 `investmentPreferencesJson`；`NewsletterPreferences` 尾端新增
  `emailDeliveryConsent`、`lineDeliveryConsent`。
- 不刪除、不重排、不回填既有資料；非精確舊版表頭會以 `schema_mismatch` 停止。

## 執行順序

1. 匯出整份 Spreadsheet 備份，記錄檔案 ID、Apps Script version 與兩個 deployment version。
2. 先在複製的 Spreadsheet 執行 `migrateReferralCommissionSchema()`，再執行 `migrateGrowthSchema()`。
3. 執行 `validateDeploymentConfiguration()` 與 `productionPreflight()`；輸出不得包含 secret。
4. 執行 `installNotificationQueueTrigger()` 與 `installDailyDigestTrigger()`，確認各只有一個 trigger。
5. 以測試管理員匯入一筆含來源與隱私同意證據的名單，連結測試會員，建立認購並確認
   `acquisitionAttributionSnapshotJson` 有 `ownerReferrerId/leadId/capturedAt`、沒有姓名/email/電話。
   名單 CSV 匯出必須以 `lead-export-v1` 為第一欄，且固定為 18 欄；業績統計分開 requested 與 allocated。
6. 發布一筆 `publicSafe` 公開內容及一筆 qualified 專案內容，確認公開 feed 只見前者，
   有效資格加逐案權限的會員才見後者。
7. 以兩位測試會員分別啟用 LINE 與 Email 摘要。確認同日重跑不重送；Email 要以真實 inbox
   收件、LINE 要以實際裝置收到訊息作驗收，不能只看 queue、HTTP 或 MailApp quota。

## 回復方式

程式發版採新 immutable version；若需回復，將兩個 deployment 指回前一版本。新增欄位與 Sheet
保留不刪除，避免破壞已建立的 attribution/audit。排程可在 Apps Script Triggers UI 暫停，
但不要刪除每日摘要或名單列；問題排除後重新執行兩個 idempotent installer。
