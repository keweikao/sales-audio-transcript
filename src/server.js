// 載入環境變數
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const Queue = require('bull');
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

// 設定 Redis 和 Bull Queue
const redisUrl = process.env.REDIS_URL || process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379';
logger.info(`Connecting to Redis via: ${redisUrl}`);

const audioQueue = new Queue('audio transcription', redisUrl);

// Redis 連接錯誤處理
audioQueue.on('error', (error) => {
  logger.error(`Redis/Queue 連接錯誤: ${error.message}`);
});

// 設定 Queue 處理器
const CONCURRENT_JOBS = process.env.CONCURRENT_JOBS || 1; // 預設改為1，因為 whisper 已經很耗資源
audioQueue.process(CONCURRENT_JOBS, async (job) => {
  return await processTranscriptionJob(job);
});

// 任務處理函數
async function processTranscriptionJob(job) {
  const { fileId, fileName, caseId } = job.data;
  let localFilePath = null;

  try {
    logger.info(`🎬 開始處理轉錄任務 - Case ID: ${caseId}`);

    // 1. 從 Google Drive 下載音檔
    logger.info(`📥 步驟 1/4: 正在從 Google Drive 下載音檔...`);
    localFilePath = await downloadFromGoogleDrive(fileId, fileName);

    // 2. 使用 faster-whisper 進行轉錄
    logger.info(`🤖 步驟 2/4: 使用 faster-whisper 轉錄...`);
    const { transcript, quality, audioInfo } = await transcribeAudio(localFilePath);
    const processingMethod = 'faster-whisper';

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
    logger.error(`❌ 轉錄最終失敗 - Case ID: ${caseId}, Error: ${error.message}`);
    qualityMonitor.recordTranscription({
      success: false,
      caseId: caseId,
      error: error.message
    });
    await updateGoogleSheet(caseId, `轉錄失敗: ${error.message}`, '轉錄失敗');
    throw error; // 讓 Bull Queue 知道任務失敗
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
    service: 'Zeabur Whisper Optimized Transcription Service',
    version: '1.2.0', // Trivial version bump
    status: 'running',
    description: '專為 iPhone 音檔優化的 AI 轉錄服務，使用 faster-whisper 提供高品質轉錄'
  });
});

app.post('/transcribe', async (req, res) => {
  try {
    const { fileId, fileName, caseId } = req.body;
    if (!fileId || !caseId) {
      return res.status(400).json({ error: '缺少必要參數: fileId 或 caseId' });
    }

    const job = await audioQueue.add({ fileId, fileName, caseId }, {
      attempts: 2, // 加上第一次，總共嘗試2次
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 30 * 60 * 1000 // Set job timeout to 30 minutes (30 * 60 * 1000 ms)
    });

    logger.info(`任務已加入佇列 - Job ID: ${job.id}, Case ID: ${caseId}`);
    res.status(202).json({
      message: '轉錄任務已提交',
      jobId: job.id,
      caseId,
      processingMethod: 'faster-whisper'
    });

  } catch (error) {
    logger.error(`提交任務失敗: ${error.message}`);
    res.status(500).json({ error: '內部伺服器錯誤', message: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    const queueStats = await audioQueue.getJobCounts();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      queue: queueStats
    });
  } catch (error) {
    res.status(503).json({
        status: 'unhealthy',
        reason: 'Could not connect to Redis or Bull queue.',
        error: error.message
    });
  }
});

app.get('/job/:jobId', async (req, res) => {
    try {
      const job = await audioQueue.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: '任務不存在' });
      }
      res.json({
        id: job.id,
        data: job.data,
        progress: job.progress,
        state: await job.getState(),
        result: job.returnvalue,
        failedReason: job.failedReason
      });
    } catch (error) {
      logger.error(`取得任務狀態失敗: ${error.message}`);
      res.status(500).json({ error: '內部伺服器錯誤' });
    }
});

// 錯誤處理中介軟體
app.use((error, req, res, next) => {
  logger.error(`未處理的錯誤: ${error.message}`);
  res.status(500).json({ error: '內部伺服器錯誤' });
});

// 啟動服務器
app.listen(port, () => {
  logger.info(`Faster-Whisper 轉錄服務 (v1.2.0) 已啟動在 port ${port}`);
});

// 優雅關閉
const gracefulShutdown = () => {
  logger.info('收到關閉信號，正在關閉服務器...');
  audioQueue.close().then(() => {
    logger.info('Bull Queue 已關閉');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);