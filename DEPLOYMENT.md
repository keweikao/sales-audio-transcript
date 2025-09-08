# Zeabur 部署指南

## 快速部署步驟

### 1. 準備 Git 倉庫

```bash
cd /Users/stephen/Desktop/zeabur-whisper-optimized
git init
git add .
git commit -m "Initial commit: iPhone optimized transcription service"
```

### 2. 推送到 GitHub

```bash
# 創建 GitHub 倉庫後
git remote add origin https://github.com/your-username/zeabur-whisper-optimized.git
git push -u origin main
```

### 3. 在 Zeabur 部署

1. 訪問 [Zeabur 控制台](https://zeabur.com/)
2. 點擊 "Create Project"
3. 選擇 "Deploy from GitHub"
4. 選擇您的倉庫 `zeabur-whisper-optimized`
5. 選擇 "Node.js" 作為運行環境

### 4. 配置環境變數

在 Zeabur 控制台的環境變數設定中添加：

```bash
NODE_ENV=production
PORT=3000
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"your-project-id",...}
GOOGLE_SPREADSHEET_ID=your-spreadsheet-id
OPENAI_API_KEY=sk-proj-your-openai-api-key
QUALITY_THRESHOLD_SCORE=60
QUALITY_THRESHOLD_CONFIDENCE=0.6
CONSECUTIVE_FAILURES_THRESHOLD=3
WHISPER_MODEL_NAME=large
WHISPER_CHUNK_DURATION=720
WHISPER_PREPROCESSING_BITRATE=96
WHISPER_PREPROCESSING_SAMPLE_RATE=24000
LOG_LEVEL=info
LOG_FILE=app.log
ENABLE_IPHONE_OPTIMIZATION=true
ENABLE_OPENAI_FALLBACK=true
ENABLE_QUALITY_MONITORING=true
ENABLE_SMART_SEGMENTATION=true
```

**注意**: 請使用您實際的環境變數值，不要使用上面的範例值。

### 5. 添加 Redis 服務

1. 在 Zeabur 項目中點擊 "Add Service"
2. 選擇 "Redis"
3. 選擇版本 7
4. 部署 Redis 服務

### 6. 更新 n8n HTTP Request

將 n8n 中的 HTTP Request 節點網址更新為您的 Zeabur 服務網址：

```
# 原來的網址
https://sales-audio-transcript-637018937599.asia-southeast1.run.app

# 更新為您的 Zeabur 網址
https://your-app-name.zeabur.app
```

### 7. 測試部署

部署完成後，您可以測試以下端點：

```bash
# 健康檢查
curl https://your-app-name.zeabur.app/health

# 品質監控
curl https://your-app-name.zeabur.app/quality

# 轉錄測試 (需要實際的 Google Drive 檔案 ID)
curl -X POST https://your-app-name.zeabur.app/transcribe \
  -H "Content-Type: application/json" \
  -d '{
    "fileId": "your-google-drive-file-id",
    "fileName": "test.m4a",
    "caseId": "test-001"
  }'
```

## 監控和維護

### 檢查服務狀態

```bash
# 服務健康檢查
curl https://your-app-name.zeabur.app/health

# 品質監控報告
curl https://your-app-name.zeabur.app/quality
```

### 查看日誌

在 Zeabur 控制台中查看應用日誌，監控：
- 轉錄成功率
- 品質評分趨勢
- 降級機制觸發情況
- 系統資源使用情況

### 成本優化建議

1. **監控降級頻率**: 如果經常使用 OpenAI API，考慮調整品質閾值
2. **調整資源配置**: 根據實際使用情況調整 CPU 和記憶體
3. **優化分塊策略**: 根據處理速度調整音檔分塊大小

## 故障排除

### 常見問題

1. **Redis 連接失敗**
   - 確保 Redis 服務正常運行
   - 檢查環境變數 `REDIS_HOST` 和 `REDIS_PORT`

2. **Google API 權限問題**
   - 確保服務帳戶有 Google Drive 和 Sheets 權限
   - 檢查 `GOOGLE_SERVICE_ACCOUNT_KEY` 格式

3. **轉錄品質不佳**
   - 檢查 iPhone 優化參數
   - 調整品質閾值設定

4. **OpenAI API 額度不足**
   - 檢查 API 使用量
   - 考慮調整降級觸發條件

### 聯繫支援

如有問題，請提供以下資訊：
- 錯誤日誌
- 環境變數配置（隱去敏感資訊）
- 測試用的音檔 ID
- 預期行為描述

---

部署完成後，您的 n8n 工作流程將無縫整合新的 Zeabur 轉錄服務！