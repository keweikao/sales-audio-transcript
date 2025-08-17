# Zeabur Whisper 優化轉錄服務

針對 iPhone 錄音優化的音頻轉錄服務，部署在 Zeabur 平台，使用 Faster-Whisper 提供高品質本地轉錄。

## 主要功能

### 🎯 iPhone 錄音優化
- **智能檢測**: 自動識別 iPhone 錄音格式和特徵
- **專用預處理**: 針對 iPhone 錄音的音頻優化濾波器
- **質量保證**: 特殊的品質評估和優化參數

### 🔄 本地轉錄處理
- **Faster-Whisper**: 使用高效能的本地 Whisper 模型
- **品質監控**: 實時評估轉錄品質和信心度
- **成本優化**: 完全本地處理，無需外部 API 費用

### 📊 完整的品質監控
- **即時統計**: 轉錄成功率、平均品質分數
- **趨勢分析**: 品質變化趨勢和系統健康度
- **預警機制**: 連續失敗和品質下降警告

### 🚀 高效處理
- **智能分割**: 基於語音停頓的智能音頻分割
- **批次處理**: Bull Queue 佇列管理，支援並發處理
- **資源優化**: 記憶體和 CPU 使用優化

## 技術架構

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Google Drive  │────│  轉錄服務核心    │────│  Google Sheets  │
│   音檔下載      │    │  Whisper 處理    │    │  結果更新       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                       ┌─────────────┐
                       │  Redis 佇列  │
                       │  Bull Queue  │
                       └─────────────┘
```

## 部署指南

### 1. 環境設定

複製環境變數範例並設定：
```bash
cp .env.example .env
```

必要的環境變數：
- `GOOGLE_SERVICE_ACCOUNT_KEY`: Google 服務帳戶金鑰
- `GOOGLE_SPREADSHEET_ID`: Google Sheets 試算表 ID
- `WHISPER_MODEL_SIZE`: Whisper 模型大小 (base/small/medium/large)

### 2. Zeabur 部署

1. 將代碼推送到 GitHub 倉庫
2. 在 Zeabur 控制台連接倉庫
3. 設定環境變數
4. 部署服務

### 3. 本地開發

```bash
# 安裝依賴
npm install

# 啟動開發模式
npm run dev

# 啟動生產模式
npm start
```

## API 文檔

### 轉錄音頻
```http
POST /transcribe
Content-Type: application/json

{
  "fileId": "google-drive-file-id",
  "fileName": "audio.m4a",
  "caseId": "case-001"
}
```

### 檢查任務狀態
```http
GET /job/{jobId}
```

### 品質監控
```http
GET /quality
```

### 健康檢查
```http
GET /health
```

## 品質評估標準

### 評分機制
- **優秀 (90-100)**: 高品質轉錄，效果極佳
- **良好 (75-89)**: 品質良好，完全可用
- **可接受 (60-74)**: 品質普通，基本可用
- **較差 (40-59)**: 品質不佳，需要檢查
- **失敗 (0-39)**: 品質極差，轉錄失敗

### 品質監控指標
- 品質分數追蹤
- 信心度評估
- 重複內容檢測
- 中文字元比例分析
- 連續失敗次數統計

## 成本估算

### 每月 200-250 個音檔 (平均 40 分鐘)
- **主要成本**: Zeabur 服務費用 (~$20-30/月)
- **運算資源**: CPU 和記憶體使用 (已包含在服務費用中)
- **總成本**: 約 $20-30/月

### 與純 API 方案比較
- 純 OpenAI API: ~$150-200/月
- 本方案節省: ~85-90%

## 監控和維護

### 日誌
- 應用日誌: `/app/logs/app.log`
- 品質統計: `/app/data/quality-stats.json`

### 管理端點
- 重置品質統計: `POST /admin/reset-quality-stats`
- 系統診斷: `POST /admin/diagnose`

### 監控指標
- 轉錄成功率
- 平均品質分數
- 處理時間
- 品質趨勢分析
- 系統健康度

## 故障排除

### 常見問題
1. **音檔下載失敗**: 檢查 Google Drive 權限
2. **轉錄品質不佳**: 調整 iPhone 優化參數
3. **記憶體不足**: 增加 Zeabur 資源配置
4. **Redis 連接失敗**: 檢查 Redis 服務狀態

### 效能調優
- 調整分塊大小 (`AUDIO_CHUNK_DURATION`)
- 優化預處理參數 (`AUDIO_PREPROCESSING_*`)
- 調整品質閾值 (`QUALITY_THRESHOLD_*`)
- 選擇合適的 Whisper 模型大小 (`WHISPER_MODEL_SIZE`)

## 支援

如有問題或建議，請提交 Issue 或聯繫開發團隊。

---

**注意**: 此服務專為 iPhone 錄音優化，其他設備錄音的效果可能有所不同。建議在部署前進行測試。