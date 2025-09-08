# 📊 銷售 AI 分析自動化系統

## Google Apps Script + Zeabur 轉錄整合方案

這是一個整合 Google Apps Script 和 Zeabur 轉錄服務的銷售逐字稿 AI 分析自動化系統。

### 🎯 系統組成

#### 1. Google Apps Script 自動化系統
完全基於 Google Apps Script 的銷售逐字稿 AI 分析自動化系統，功能包括：

📥 **Webhook 接收** 透過 Zeabur 接收音頻上傳請求  
🎤 **自動轉錄** 調用 Zeabur 轉錄服務進行音頻轉錄  
✅ **狀態監控** Google Sheets 中的轉錄完成狀態  
🤖 **AI 分析** 使用 Google Gemini 分析銷售對話  
💬 **Slack 通知** 自動推送結果給業務員  
📊 **回饋收集** Google Form 收集人工回饋

#### 2. Zeabur 轉錄服務
針對 iPhone 錄音優化的音頻轉錄服務，使用 Faster-Whisper 提供高品質本地轉錄：

🎯 **iPhone 錄音優化** - 智能檢測和專用預處理  
🔄 **本地轉錄處理** - Faster-Whisper 高效能處理  
📊 **完整品質監控** - 即時統計和趨勢分析  
🚀 **高效處理** - Bull Queue 佇列管理

## 🛠️ 系統架構

```
Google Form → Google Sheets → Apps Script → Zeabur API → Whisper
     ↓              ↑              ↓           ↑         ↓
  音檔上傳     →  轉錄完成     →  Webhook    →  轉錄處理  →  結果回傳
                    ↓
            Gemini AI 分析 → Slack 通知 → 業務回饋
```

## 📋 主要功能

### Google Apps Script 端
- **音檔管理 & 自動同步**: Google Form 整合和智能佇列處理
- **Webhook 處理**: 接收轉錄完成回調
- **AI 分析**: Gemini AI 智能分析銷售對話
- **Slack 整合**: 個人化通知和互動式內容
- **回饋收集**: 預填表單和資料整合

### Zeabur 轉錄服務端  
- **iPhone 優化**: 自動識別格式和專用預處理
- **品質監控**: 實時評估轉錄品質和信心度
- **成本優化**: 完全本地處理，無需外部 API
- **資源優化**: 記憶體和 CPU 使用優化

## 🔧 設定指南

### 1. Google Apps Script 設定

#### 建立新的 Apps Script 專案
1. 前往 [Google Apps Script](https://script.google.com)
2. 建立新專案
3. 將所有 `.gs` 檔案的內容複製到對應的檔案中

#### 設定檔案清單
- `config.gs` - 系統設定檔
- `main.gs` - 主要處理邏輯和 webhook 處理器
- `sheetsService.gs` - Google Sheets 服務
- `slackService.gs` - Slack 整合服務  
- `geminiService.gs` - Gemini AI 服務
- `maintenance.gs` - 維護工具
- `fileTriggerHandler.gs` - 檔案觸發處理器

#### Webhook 設定
1. 部署 Apps Script 為網頁應用程式
2. 設定執行權限為「任何人」
3. 將網頁應用程式 URL 提供給 Zeabur 轉錄服務

### 2. Zeabur 轉錄服務部署

#### 環境設定
複製環境變數範例並設定：
```bash
cp .env.example .env
```

必要的環境變數：
- `GOOGLE_SERVICE_ACCOUNT_KEY`: Google 服務帳戶金鑰
- `GOOGLE_SPREADSHEET_ID`: Google Sheets 試算表 ID
- `WHISPER_MODEL_SIZE`: Whisper 模型大小 (base/small/medium/large)
- `WEBHOOK_URL`: Google Apps Script 網頁應用程式 URL

#### Zeabur 部署
1. 將代碼推送到 GitHub 倉庫
2. 在 Zeabur 控制台連接倉庫
3. 設定環境變數
4. 部署服務

## 🚀 完整工作流程

1. **上傳音檔**: 業務員透過 Google Form 上傳音檔
2. **自動同步**: Apps Script 每 10 分鐘同步表單回應
3. **轉錄請求**: 智能佇列處理器發送請求到 Zeabur
4. **轉錄處理**: Zeabur 使用 Whisper 進行本地轉錄
5. **結果回傳**: Zeabur 透過 webhook 回傳轉錄結果給 Apps Script
6. **AI 分析**: Apps Script 使用 Gemini AI 分析內容
7. **推送通知**: 透過 Slack 通知對應業務員
8. **收集回饋**: 業務員填寫回饋表單
9. **回饋分析**: 系統整合人工回饋與 AI 分析結果

## 📊 成本估算 (每月 200-250 個音檔)

### Google Apps Script 端
- **Google Apps Script**: 免費 (在配額內)
- **Google Sheets/Drive**: 免費
- **Gemini API**: ~$10-20

### Zeabur 轉錄服務端  
- **Zeabur 服務費用**: ~$20-30/月
- **本地 Whisper 處理**: 已包含

### 總成本對比
- **本方案**: ~$30-50/月
- **純 OpenAI API 方案**: ~$150-200/月
- **節省成本**: 75-80%

## 🎯 系統特色

✅ **全自動化** 的銷售逐字稿分析流程  
📊 **即時更新** 的 Google Sheets 分析結果  
💬 **個人化** 的 Slack 通知給每位業務員  
🤖 **AI 輔助** 的客戶分析和建議  
📈 **低成本** 且高效率的運營方式  
🎯 **iPhone 優化** 的高品質轉錄服務

---

如有任何問題，請檢查系統日誌或執行 `systemHealthCheck()` 進行診斷。