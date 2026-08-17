# LINE Messaging API 憑證輪替 Runbook

> 適用情境：Messaging API channel secret 或 channel access token 曾出現在聊天、工單、日誌、截圖或版本庫。只要第三方可能讀到，就按「已外洩」處理；本文不記錄任何實際憑證。

## 1. 立即處置

1. 暫停把憑證貼到聊天或指令參數，並盤點目前讀取憑證的正式環境、測試環境與自動化工作。Channel secret 是 LINE Platform 與開發者才應知道、由 bot server 管理的私密金鑰；channel access token 外洩則可能讓第三方以該 channel 權限發送訊息。[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)、[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)
2. 先準備好伺服器端秘密儲存與部署路徑。本專案只把 secret/token 放入執行平台的 server-side secret store；不得放入 Git、GitHub Pages、瀏覽器 JavaScript、建置產物或可被前端下載的環境變數。這是把 LINE 所要求的「由 bot server 妥善管理」落實到本專案的控制方式。[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
3. 將事件起訖時間、執行者、受影響環境、輪替後驗證結果記入內部事故紀錄，但不要在事故紀錄或本文保存 secret/token 本體。[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)

## 2. 輪替 channel secret

1. 由具有 channel **Admin** 權限的人進入 LINE Developers Console，開啟該 Messaging API channel 的 **Basic settings**，在 **Channel secret** 點選 **Issue**。重新發行會立即使舊 channel secret 失效，LINE 不會在未經管理員同意下自動重發，因此操作前要先確認所有 webhook 驗證程式與部署位置。[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
2. 立即把新值寫入正式 bot server 的 secret store，重新部署或重新載入執行環境；不要把值寫入 repo、前端或本文件。重新發行後，仍使用舊 secret 的 webhook 驗證會失敗。[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
3. 在 LINE Developers Console 對 Webhook URL 按 **Verify**；LINE 會送出 `events` 為空陣列的 POST，bot server 必須回 `200`。應同時確認應用程式以「未修改的原始 request body」及 `x-line-signature`，使用 HMAC-SHA256 驗證成功後才處理 payload。[Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)、[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

## 3. 輪替 channel access token

### 選擇 token 類型

正式系統優先採用 **channel access token v2.1**。LINE 的建置指南目前將 v2.1 標為 recommended；它可自訂最長 30 天期限、每個 channel 最多 30 枚、可驗證與撤銷，並用 `key_id` 盤點有效 token。應在到期前自動發行下一枚，完成切換後撤銷舊枚。[Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)、[Issue v2.1 token](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)

- Stateless token 有效 15 分鐘、無發行數量上限，但**不能撤銷**；它適合能安全、自動頻繁發行的架構，不適合作為本次必須立即撤銷已外洩 token 的唯一補救方式。[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)、[Stop using Messaging API](https://developers.line.biz/en/docs/messaging-api/stop-using-messaging-api/)
- Long-lived token 沒有到期日且每個 channel 只能有一枚；LINE 的企業開發指南基於安全理由不建議新發行 long-lived token。[Channel access token](https://developers.line.biz/en/docs/basics/channel-access-token/)、[Development guidelines](https://developers.line.biz/en/docs/partner-docs/development-guidelines/)

### v2.1 安全切換

1. 依官方流程建立 assertion signing key pair，只向 LINE 註冊 public key；用 private key 簽出短效 JWT assertion，再透過 v2.1 發行端點取得新的 token 與 `key_id`。token 與 `key_id` 必須成對安全保存。[Issue v2.1 token](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)
2. 把新 token 寫入 server-side secret store，部署到所有訊息發送工作，再呼叫 v2.1 verify endpoint；成功結果須對應預期 channel ID，且 `expires_in` 為正值。[Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
3. 用新的 token 對一名已加好友的內部測試者做最小範圍 push 驗證。Push 必須指定 user ID；可可靠接收的對象包括已加 OA 好友的使用者，而封鎖 OA 等情況即使 API 回 `200` 也可能不會收到訊息。[Push message reference](https://developers.line.biz/en/reference/messaging-api/#send-push-message)
4. 確認所有正式工作都已使用新 token 後，立即撤銷舊 token。v2.1 應先用「取得所有有效 `key_id`」端點核對目前有效清單，再用舊 token 呼叫 v2.1 revoke；單看 revoke 的成功回應不足以證明一枚無效 token 曾有效，因為傳入無效 token 也不會報錯。[Issue v2.1 token](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)、[Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)
5. 再查一次有效 `key_id` 清單，確認舊 `key_id` 已消失；保留結果、時間與 LINE request ID 作為輪替證據，不保存 token 本體。[Issue v2.1 token](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)

若目前使用 short-lived 或 long-lived token，應透過其 verify endpoint 確認 channel 與期限，完成新 token 切換後呼叫對應的 revoke endpoint；不要拿 LINE Login 的 access-token revoke endpoint 處理 Messaging API token。[Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)、[LINE Login API reference](https://developers.line.biz/en/reference/line-login/)

## 4. 這組 Messaging API 資源能做什麼

完成安全輪替且 bot server 上線後，Messaging API channel access token 可授權伺服器呼叫 reply、push、multicast、narrowcast、broadcast 等訊息端點；channel secret 則用來驗證 LINE webhook 的 HMAC-SHA256 簽章。兩者用途不同，不能互相替代。[Send messages](https://developers.line.biz/en/docs/messaging-api/sending-messages/)、[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

但只有 Messaging API channel ID、secret 與 token，仍**不能**完成以下正式驗收：

- **網站會員 LINE 登入**：網站透過 LINE 帳號註冊／登入需要另建 LINE Login channel。為讓同一使用者在 Login 與 Messaging API 取得相同 user ID，兩個 channel 必須放在同一 Provider。[LINE Login overview](https://developers.line.biz/en/docs/line-login/overview/)、[Get user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)
- **確認真實通知收件人**：Push 需要 user ID 與符合投遞條件的對象；至少要有一名內部測試 LINE 帳號加入該 OA 好友，才能確認端到端實際收件。僅有 API `200` 不保證被封鎖或未加好友的使用者收到訊息。[Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[Push message reference](https://developers.line.biz/en/reference/messaging-api/#send-push-message)
- **接收 follow/message/unfollow 與建立 user ID 證據**：必須先部署 LINE 可從公網連入、使用一般瀏覽器信任 CA 憑證的 HTTPS webhook URL；self-signed certificate 不受支援。本機網址若沒有公開 HTTPS tunnel，仍只能做憑證輪替與 outbound API 檢查，不能完成 live webhook 驗收。上線後還須在 Console 設定並啟用 **Use webhook**、通過 Verify，且每次都先驗證簽章；使用者加好友或傳訊時，LINE 才會把包含 user ID 的事件 POST 到該 URL。[Build a bot](https://developers.line.biz/en/docs/messaging-api/building-bot/)、[Receive webhooks](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)、[Get user IDs](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)、[Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)

補充：Messaging API 本身另有「user account linking」流程，可在不建立 LINE Login channel 的情況下，把既有服務帳號與 LINE user ID 綁定；但它仍要求服務自己的登入、一次性 nonce/link token 與 webhook，並不等於本專案所需的 LINE 網站登入。[User account linking](https://developers.line.biz/en/docs/messaging-api/linking-accounts/)

## 5. 完成標準

- 舊 channel secret 已因重新發行而失效，新 secret 可驗證 Console 測試 webhook。[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- 舊 channel access token 已撤銷；v2.1 有效 `key_id` 清單只保留已登記的現役 token。[Issue v2.1 token](https://developers.line.biz/en/docs/messaging-api/generate-json-web-token/)
- 新 token verify 回應屬於預期 channel 且尚未過期；內部 OA 好友實際收到最小測試 push。[Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)、[Push message reference](https://developers.line.biz/en/reference/messaging-api/#send-push-message)
- webhook URL Verify 回 `200`，應用程式記錄顯示原始 body 的簽章驗證成功。[Verify webhook URL](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)、[Webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- 正式會員登入仍維持關閉，直到同 Provider 的 LINE Login channel、callback URL 與真實登入驗收完成。[LINE Login overview](https://developers.line.biz/en/docs/line-login/overview/)、[Best practices for provider/channel management](https://developers.line.biz/en/docs/line-developers-console/best-practices-for-provider-and-channel-management/)
