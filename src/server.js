const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const Queue = require('bull');
const OpenAI = require('openai');
const fs = require('fs');
const { transcribeAudio } = require('./services/transcriptionService');
const { downloadFromGoogleDrive } = require('./services/googleDriveService');
const { updateGoogleSheet } = require('./services/googleSheetsService');
const QualityMonitor = require('./services/qualityMonitor');
const { assessTranscriptionQuality } = require('./services/transcriptionService');

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

// 初始化 OpenAI 客戶端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
const audioQueue = new Queue('audio transcription', {
  redis: {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || 'localhost',
  }
});

// 設定 Queue 處理器
audioQueue.process(async (job) => {
  const { fileId, fileName, caseId, forceOpenAI } = job.data;
  
  try {
    logger.info(`開始處理轉錄任務 - Case ID: ${caseId}`);
    
    // 1. 從 Google Drive 下載音檔
    const localFilePath = await downloadFromGoogleDrive(fileId, fileName);
    
    let transcript = '';
    let quality = null;
    let processingMethod = 'faster-whisper';
    
    // 2. 決定使用哪種轉錄方法
    if (forceOpenAI) {
      // 如果強制使用 OpenAI API
      logger.info('使用 OpenAI API 轉錄（強制模式）');
      const result = await transcribeWithOpenAI(localFilePath);
      transcript = result.transcript;
      quality = result.quality;
      processingMethod = 'openai-api';
    } else {
      // 先嘗試 Faster-Whisper
      logger.info('使用 Faster-Whisper 轉錄');
      const result = await transcribeAudio(localFilePath);
      transcript = result.transcript;
      quality = result.quality;
      
      // 檢查是否需要降級到 OpenAI API
      const fallbackDecision = qualityMonitor.shouldFallbackToOpenAI(quality);
      
      if (fallbackDecision.shouldFallback) {
        logger.warn(`品質不佳，嘗試使用 OpenAI API 重新轉錄`);
        
        try {
          const openaiResult = await transcribeWithOpenAI(localFilePath);
          
          // 比較結果品質
          if (openaiResult.quality.score > quality.score) {
            logger.info(`OpenAI API 結果更好，使用 OpenAI 結果`);
            transcript = openaiResult.transcript;
            quality = openaiResult.quality;
            processingMethod = 'openai-api-fallback';
          } else {
            logger.info(`Faster-Whisper 結果較佳，保持原結果`);
            processingMethod = 'faster-whisper-confirmed';
          }
        } catch (openaiError) {
          logger.error(`OpenAI API 降級失敗: ${openaiError.message}`);
          // 保持 Faster-Whisper 結果
          processingMethod = 'faster-whisper-fallback-failed';
        }
      }
    }
    
    // 3. 記錄品質監控
    qualityMonitor.recordTranscription({
      success: true,
      caseId: caseId,
      quality: quality,
      processingMethod: processingMethod
    });
    
    // 4. 更新 Google Sheets
    await updateGoogleSheet(caseId, transcript, 'Completed', {
      processingMethod: processingMethod,
      qualityScore: quality.score,
      confidence: quality.confidence
    });
    
    logger.info(`轉錄完成 - Case ID: ${caseId}, 方法: ${processingMethod}, 品質: ${quality.score}/100`);
    
    return { 
      success: true, 
      transcript, 
      caseId, 
      quality, 
      processingMethod 
    };
    
  } catch (error) {
    logger.error(`轉錄失敗 - Case ID: ${caseId}, Error: ${error.message}`);
    
    // 記錄失敗
    qualityMonitor.recordTranscription({
      success: false,
      caseId: caseId,
      error: error.message
    });
    
    // 更新狀態為失敗
    try {
      await updateGoogleSheet(caseId, `轉錄失敗: ${error.message}`, 'Failed');
    } catch (updateError) {
      logger.error(`更新失敗狀態失敗: ${updateError.message}`);
    }
    
    throw error;
  }
});

// OpenAI API 轉錄函數
async function transcribeWithOpenAI(localFilePath) {
  try {
    logger.info(`開始使用 OpenAI API 轉錄: ${localFilePath}`);
    
    const startTime = Date.now();
    
    // 檢查檔案是否存在
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`音檔檔案不存在: ${localFilePath}`);
    }
    
    // 使用 OpenAI Whisper API 轉錄
    const audioFile = fs.createReadStream(localFilePath);
    
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: audioFile,
      language: 'zh',
      response_format: 'text',
      temperature: 0.0
    });
    
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    
    const transcript = response.trim();
    
    // 評估轉錄品質
    const quality = assessTranscriptionQuality(transcript);
    
    logger.info(`OpenAI API 轉錄完成:`)
    logger.info(`- 處理時間: ${processingTime.toFixed(2)} 秒`);
    logger.info(`- 文字長度: ${transcript.length} 字元`);
    logger.info(`- 品質評分: ${quality.score}/100`);
    logger.info(`- 信心度: ${quality.confidence.toFixed(2)}`);
    
    return {
      transcript: transcript,
      quality: quality,
      processingTime: processingTime
    };
    
  } catch (error) {
    logger.error(`OpenAI API 轉錄失敗: ${error.message}`);
    throw error;
  }
}

// API 路由
app.post('/transcribe', async (req, res) => {
  try {
    const { fileId, fileName, caseId, forceOpenAI } = req.body;
    
    if (!fileId || !caseId) {
      return res.status(400).json({
        error: '缺少必要參數: fileId 或 caseId'
      });
    }
    
    // 將任務加入佇列
    const job = await audioQueue.add({
      fileId,
      fileName: fileName || 'unknown_audio_file',
      caseId,
      forceOpenAI: forceOpenAI || false
    }, {
      attempts: 3,
      backoff: 'exponential',
      delay: 2000
    });
    
    logger.info(`任務已加入佇列 - Job ID: ${job.id}, Case ID: ${caseId}`);
    
    res.status(202).json({
      message: '轉錄任務已提交',
      jobId: job.id,
      caseId,
      processingMethod: forceOpenAI ? 'openai-api' : 'faster-whisper'
    });
    
  } catch (error) {
    logger.error(`提交任務失敗: ${error.message}`);
    res.status(500).json({
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

// 降級建議端點
app.post('/quality/check', (req, res) => {
  try {
    const { quality } = req.body;
    
    if (!quality) {
      return res.status(400).json({ error: '缺少品質資料' });
    }
    
    const fallbackDecision = qualityMonitor.shouldFallbackToOpenAI(quality);
    
    res.json({
      recommendation: fallbackDecision.shouldFallback ? 'openai-api' : 'faster-whisper',
      confidence: fallbackDecision.confidence,
      reasons: fallbackDecision.reasons
    });
    
  } catch (error) {
    logger.error(`品質檢查失敗: ${error.message}`);
    res.status(500).json({ error: '品質檢查失敗' });
  }
});

// 健康檢查端點
app.get('/health', (req, res) => {
  const report = qualityMonitor.generateQualityReport();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    queue: {
      waiting: audioQueue.waiting,
      active: audioQueue.active,
      completed: audioQueue.completed,
      failed: audioQueue.failed
    },
    quality: {
      systemHealth: report.alerts.systemHealth,
      averageQuality: report.overview.averageQuality,
      successRate: report.overview.successRate
    }
  });
});

// 取得任務狀態
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

// 管理端點 - 重置品質統計
app.post('/admin/reset-quality-stats', (req, res) => {
  try {
    qualityMonitor.resetStats();
    res.json({ message: '品質統計已重置' });
  } catch (error) {
    logger.error(`重置品質統計失敗: ${error.message}`);
    res.status(500).json({ error: '重置失敗' });
  }
});

// 管理端點 - 手動觸發 OpenAI API 轉錄
app.post('/admin/force-openai/:caseId', async (req, res) => {
  try {
    const { caseId } = req.params;
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
      return res.status(400).json({ error: '缺少 fileId' });
    }
    
    // 強制使用 OpenAI API
    const job = await audioQueue.add({
      fileId,
      fileName: fileName || 'unknown_audio_file',
      caseId,
      forceOpenAI: true
    }, {
      attempts: 1,
      priority: 10 // 高優先權
    });
    
    res.json({
      message: '已強制使用 OpenAI API 重新轉錄',
      jobId: job.id,
      caseId
    });
    
  } catch (error) {
    logger.error(`強制 OpenAI API 轉錄失敗: ${error.message}`);
    res.status(500).json({ error: '操作失敗' });
  }
});

// 錯誤處理中介軟體
app.use((error, req, res, next) => {
  logger.error(`未處理的錯誤: ${error.message}`);
  res.status(500).json({
    error: '內部伺服器錯誤',
    message: process.env.NODE_ENV === 'development' ? error.message : '請聯繫管理員'
  });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    error: '路由不存在',
    path: req.path
  });
});

// 啟動服務器
app.listen(port, () => {
  logger.info(`優化版轉錄服務已啟動在 port ${port}`);
  logger.info(`品質監控: 啟用`);
  logger.info(`降級機制: 啟用`);
});

// 優雅關閉
process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM，正在關閉服務器...');
  audioQueue.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('收到 SIGINT，正在關閉服務器...');
  audioQueue.close();
  process.exit(0);
});

module.exports = app;