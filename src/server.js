// 載入環境變數
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const fs = require('fs');
const { transcribeAudio, assessTranscriptionQuality } = require('./services/transcriptionService');
const { downloadFromGoogleDrive } = require('./services/googleDriveService');
const { updateGoogleSheet } = require('./services/googleSheetsService');
const QualityMonitor = require('./services/qualityMonitor');

// 設定日誌
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

const app = express();
const port = process.env.PORT || 3000;

// 初始化品質監控
const qualityMonitor = new QualityMonitor();

// 設定中介軟體
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 記錄所有請求
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// 簡化版 - 移除佇列系統，由 GAS 管理佇列
logger.info('🔄 Zeabur 簡化版 - 專職轉錄服務 (佇列由 GAS 管理)');

// 任務處理函數 (移除佇列依賴)
async function processTranscriptionJob(jobData) {
  const { fileId, fileName, caseId } = jobData.data || jobData;
  let localFilePath = null;

  try {
    logger.info(`🎬 開始處理轉錄任務 - Case ID: ${caseId}`);

    // 1. 從 Google Drive 下載音檔
    logger.info(`📥 步驟 1/4: 正在從 Google Drive 下載音檔...`);
    localFilePath = await downloadFromGoogleDrive(fileId, fileName);

    // 2. 使用 OpenAI whisper 進行轉錄
    logger.info(`🤖 步驟 2/4: 使用 OpenAI whisper 轉錄...`);
    const { transcript, quality, audioInfo } = await transcribeAudio(localFilePath);
    const processingMethod = 'openai-whisper';

    // 3. 記錄品質監控
    logger.info(`📊 步驟 3/4: 記錄品質監控...`);
    qualityMonitor.recordTranscription({
      success: true,
      caseId: caseId,
      quality: quality,
      processingMethod: processingMethod
    });

    // 4. 更新 Google Sheets
    logger.info(`📝 步驟 4/4: 更新 Google Sheets...`);
    await updateGoogleSheet(caseId, transcript, 'Completed', {
      processingMethod: processingMethod,
      qualityScore: quality.score,
      confidence: quality.confidence
    });

    logger.info(`🎉 轉錄任務完成 - Case ID: ${caseId}`);
    logger.info(`📈 最終結果: 方法=${processingMethod}, 品質=${quality.score}/100, 文字長度=${transcript.length}字元`);

    return { 
      success: true, 
      transcript, 
      caseId, 
      quality, 
      processingMethod 
    };

  } catch (error) {
    logger.error(`❌ 轉錄失敗 - Case ID: ${caseId}, Error: ${error.message}`);
    qualityMonitor.recordTranscription({
      success: false,
      caseId: caseId,
      error: error.message
    });
    
    // 嘗試更新 Sheets 失敗狀態
    try {
      await updateGoogleSheet(caseId, `轉錄失敗: ${error.message}`, '轉錄失敗');
    } catch (sheetError) {
      logger.error(`更新失敗狀態到 Sheets 也失敗: ${sheetError.message}`);
    }
    
    throw error;
  } finally {
    // 清理本地臨時檔案
    if (localFilePath && fs.existsSync(localFilePath)) {
        try {
            const dir = require('path').dirname(localFilePath);
            fs.rmSync(dir, { recursive: true, force: true });
            logger.info(`🗑️ 已清理臨時目錄`);
        } catch(e) {
            logger.warn(`⚠️ 清理臨時目錄失敗: ${e.message}`);
        }
    }
  }
}

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.json({
    service: 'Zeabur 簡化轉錄服務',
    version: '2.0.0', 
    status: 'running',
    description: '專為 GAS 智能佇列設計的單純轉錄服務',
    queueManagement: 'Managed by GAS Smart Queue'
  });
});

// 簡化版 /transcribe API - 僅支援 direct 模式
app.post('/transcribe', async (req, res) => {
  try {
    const { fileId, fileName, caseId } = req.body;
    if (!fileId || !caseId) {
      return res.status(400).json({ error: '缺少必要參數: fileId 或 caseId' });
    }

    logger.info(`🚀 開始轉錄任務 - Case ID: ${caseId}`);
    
    // 設定請求超時為 45 分鐘
    req.setTimeout(45 * 60 * 1000);
    
    try {
      const result = await processTranscriptionJob({ 
        data: { fileId, fileName, caseId } 
      });
      
      res.json({
        success: true,
        message: '轉錄任務已完成',
        caseId,
        transcript: result.transcript,
        quality: result.quality,
        processingMethod: 'openai-whisper-direct'
      });
      
    } catch (directError) {
      logger.error(`轉錄處理失敗: ${directError.message}`);
      res.status(500).json({ 
        success: false,
        error: '轉錄處理失敗', 
        message: directError.message 
      });
    }

  } catch (error) {
    logger.error(`轉錄 API 請求失敗: ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: '內部伺服器錯誤', 
      message: error.message 
    });
  }
});

// 品質監控端點
app.get('/quality', (req, res) => {
  try {
    const report = qualityMonitor.generateQualityReport();
    res.json(report);
  } catch (error) {
    logger.error(`生成品質報告失敗: ${error.message}`);
    res.status(500).json({ error: '生成品質報告失敗' });
  }
});

// 簡化版健康檢查端點
app.get('/health', async (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    service: 'zeabur-transcription-simplified',
    version: '2.0.0'
  });
});

// 測試連接端點
app.get('/test', async (req, res) => {
  try {
    // 測試 Google Services 連接
    const { checkConnection: checkSheetsConnection } = require('./services/googleSheetsService');
    const { checkFileAccess } = require('./services/googleDriveService');
    
    const sheetsStatus = await checkSheetsConnection();
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        googleSheets: sheetsStatus.connected ? 'connected' : 'failed',
        googleDrive: 'available',  // 需要特定檔案ID來測試
        whisperService: 'available'
      },
      message: '簡化版轉錄服務運行正常'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// 錯誤處理中介軟體
app.use((error, req, res, next) => {
  logger.error(`未處理的錯誤: ${error.message}`);
  res.status(500).json({ error: '內部伺服器錯誤' });
});

// 啟動服務器
const server = app.listen(port, '0.0.0.0', () => {
  logger.info(`🚀 Zeabur 簡化轉錄服務 (v2.0.0) 已啟動在 port ${port}`);
  logger.info(`📊 品質監控: 啟用`);
  logger.info(`🔧 使用 OpenAI Whisper 本地轉錄`);
  logger.info(`🎯 佇列管理: 由 GAS 智能佇列負責`);
});

// 簡化版優雅關閉
const gracefulShutdown = () => {
  logger.info('收到關閉信號，正在關閉服務器...');
  server.close(() => {
    logger.info('服務器已關閉');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);