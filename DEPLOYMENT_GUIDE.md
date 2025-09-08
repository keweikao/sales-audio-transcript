# 🚀 Sales AI 完整系統部署指南

## 系統架構總覽

```
音頻上傳 → Zeabur Webhook → Google Apps Script → 完整處理流程
```

- **Zeabur**: 簡化的 HTTP 轉發服務
- **Google Apps Script**: 完整的業務邏輯處理
- **Google Sheets**: 資料存儲和狀態管理
- **Slack**: 通知服務

## 📋 部署步驟

### 第一階段：Google Apps Script 設定

1. **上傳代碼檔案**
   - 將所有 `.gs` 檔案上傳到 Google Apps Script 專案
   - 設定 `config.gs` 中的必要參數

2. **部署為 Web App**
   ```
   1. 在 Google Apps Script 中點擊「部署」→「新增部署作業」
   2. 類型選擇「網頁應用程式」
   3. 執行身分：選擇「我」
   4. 存取權：選擇「任何人」
   5. 複製生成的 Web App URL
   ```

3. **設定必要權限**
   - Google Sheets 讀寫權限
   - Gmail 發送權限（錯誤通知）
   - 外部 URL 存取權限（Gemini API + Slack API）

### 第二階段：Zeabur 服務部署

1. **準備代碼**
   ```bash
   # 確保檔案結構
   sales-ai-gas-automation/
   ├── zeabur-webhook.js
   ├── package.json
   └── DEPLOYMENT_GUIDE.md
   ```

2. **設定環境變數**
   - 在 `zeabur-webhook.js` 中更新 `GAS_WEBHOOK_URL`
   - 將你的 Google Apps Script Web App URL 替換進去

3. **部署到 Zeabur**
   ```bash
   # 方法一：直接從 GitHub 部署
   1. 將代碼推送到 GitHub repository
   2. 在 Zeabur 儀表板中連接 GitHub repository
   3. 選擇自動部署

   # 方法二：使用 Zeabur CLI
   zeabur deploy
   ```

### 第三階段：系統整合測試

1. **測試 Zeabur Webhook**
   ```bash
   curl -X POST https://your-zeabur-app.zeabur.app/audio-upload \
     -H "Content-Type: application/json" \
     -d '{
       "fileId": "test-file-id",
       "fileName": "test-audio.mp3",
       "salespersonEmail": "test@example.com"
     }'
   ```

2. **測試 GAS 健康檢查**
   ```javascript
   // 在 Google Apps Script 中執行
   systemHealthCheck();
   ```

3. **測試完整流程**
   - 上傳音頻檔案到指定的 Google Drive 資料夾
   - 觀察 Google Sheets 中的記錄
   - 確認 Slack 通知正常發送

## 🔧 重要設定項目

### Google Apps Script 設定

```javascript
// config.gs 中需要設定的項目
const CONFIG = {
  SPREADSHEET_ID: '你的試算表ID',
  GEMINI_API_KEY: '你的Gemini API金鑰',
  SLACK_BOT_TOKEN: '你的Slack Bot Token',
  // ... 其他設定
};
```

### Zeabur 環境變數

```javascript
// zeabur-webhook.js 中需要更新的項目
const GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec';
```

## 📊 監控和維護

### 日誌檢查
- **Zeabur**: 在 Zeabur 儀表板查看應用程式日誌
- **GAS**: 在 Google Apps Script 中查看執行日誌

### 健康檢查端點
- **Zeabur**: `GET https://your-app.zeabur.app/health`
- **GAS**: 執行 `systemHealthCheck()` 函數

### 定期維護任務
- 每週檢查 API 配額使用情況
- 每月清理舊的 Google Sheets 記錄
- 監控錯誤通知郵件

## 🚨 故障排除

### 常見問題

1. **Zeabur → GAS 連線失敗**
   - 檢查 GAS Web App URL 是否正確
   - 確認 GAS 部署設定為「任何人」可存取

2. **GAS → Google Sheets 寫入失敗**
   - 檢查試算表 ID 是否正確
   - 確認 GAS 有寫入權限

3. **Slack 通知失敗**
   - 檢查 Slack Bot Token 是否有效
   - 確認用戶 ID 對應表設定正確

### 偵錯模式
在 `config.gs` 中設定：
```javascript
DEBUG_MODE: true
```

## 💰 成本評估

| 服務 | 成本 |
|------|------|
| Google Apps Script | 免費 |
| Google Sheets | 免費 |
| Zeabur | ~$5/月 |
| Gemini API | ~$0.01/分析 |
| Slack API | 免費 |
| **總計** | **~$5/月 + API使用費** |

## 🎉 部署完成檢查清單

- [ ] Google Apps Script 代碼上傳完成
- [ ] Web App 部署並取得 URL
- [ ] Zeabur 服務部署成功
- [ ] 環境變數設定完成
- [ ] 系統健康檢查通過
- [ ] 完整流程測試成功
- [ ] 監控和告警設定完成

---

🎯 **恭喜！你的 Sales AI 系統現在完全運行在 Google Apps Script 上，具備更高的穩定性和更低的維護成本！**