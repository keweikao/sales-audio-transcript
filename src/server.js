// 載入環境變數
require('dotenv').config();

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
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key'
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
let redisConfig = {
  port: process.env.REDIS_PORT || 6379,
  host: process.env.REDIS_HOST || 'localhost',
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
  keepAlive: 30000,
  connectTimeout: 10000,
  commandTimeout: 5000
};

// 如果有 Redis 密碼，添加到配置中
if (process.env.REDIS_PASSWORD) {
  redisConfig.password = process.env.REDIS_PASSWORD;
}

// 如果有 Redis URL，使用 URL 配置
if (process.env.REDIS_URL || process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING) {
  const redisUrlStr = process.env.REDIS_URL || process.env.REDIS_URI || process.env.REDIS_CONNECTION_STRING;
  try {
    const redisUrl = new URL(redisUrlStr);
    redisConfig.host = redisUrl.hostname;
    redisConfig.port = redisUrl.port || 6379;
    if (redisUrl.password) {
      redisConfig.password = redisUrl.password;
    }
    logger.info(`使用 Redis URL 配置: ${redisUrl.hostname}:${redisUrl.port}`);
  } catch (error) {
    logger.error(`解析 Redis URL 失敗: ${error.message}`);
  }
}

// 調試環境變數
logger.info(`環境變數調試:`);
logger.info(`- REDIS_HOST: ${process.env.REDIS_HOST || '未設定'}`);
logger.info(`- REDIS_PORT: ${process.env.REDIS_PORT || '未設定'}`);
logger.info(`- REDIS_PASSWORD: ${process.env.REDIS_PASSWORD ? '已設定' : '未設定'}`);
logger.info(`- REDIS_URL: ${process.env.REDIS_URL || '未設定'}`);
logger.info(`- REDIS_CONNECTION_STRING: ${process.env.REDIS_CONNECTION_STRING || '未設定'}`);
logger.info(`- REDIS_URI: ${process.env.REDIS_URI || '未設定'}`);

// 檢查其他可能的 Redis 環境變數
const allEnvVars = Object.keys(process.env).filter(key => key.includes('REDIS'));
logger.info(`所有 Redis 相關環境變數: ${allEnvVars.join(', ')}`);

// 檢查 Google 服務設定
logger.info(`Google 服務設定:`);
logger.info(`- GOOGLE_SERVICE_ACCOUNT_KEY: ${process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? '已設定' : '未設定'}`);
logger.info(`- GOOGLE_SPREADSHEET_ID: ${process.env.GOOGLE_SPREADSHEET_ID || '未設定'}`);
logger.info(`- OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '已設定' : '未設定'}`);

logger.info(`Redis 連接配置: ${redisConfig.host}:${redisConfig.port}, 密碼: ${redisConfig.password ? '已設定' : '未設定'}`);

// 創建 Redis 連接測試
const Redis = require('ioredis');

// 嘗試多種連接方式
async function testRedisConnection() {
  const testConfigs = [
    // 1. 使用連接字串
    process.env.REDIS_CONNECTION_STRING || process.env.REDIS_URI,
    // 2. 使用個別參數
    redisConfig,
    // 3. 簡化配置
    {
      host: process.env.REDIS_HOST || 'redis',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    }
  ];

  for (let i = 0; i < testConfigs.length; i++) {
    const config = testConfigs[i];
    if (!config) continue;

    try {
      logger.info(`🔄 嘗試 Redis 連接配置 ${i + 1}:`, typeof config === 'string' ? config : `${config.host}:${config.port}`);
      
      const testRedis = new Redis(config);
      
      await testRedis.ping();
      logger.info(`✅ Redis 連接配置 ${i + 1} 成功！`);
      
      // 更新全局配置
      redisConfig = config;
      await testRedis.quit();
      break;
      
    } catch (error) {
      logger.error(`❌ Redis 連接配置 ${i + 1} 失敗: ${error.message}`);
      if (i === testConfigs.length - 1) {
        logger.error('🚨 所有 Redis 連接配置都失敗！');
      }
    }
  }
}

let audioQueue;

// 執行連接測試並初始化 Queue
testRedisConnection()
  .then(() => {
    // Redis 連接成功後初始化 Queue
    audioQueue = new Queue('audio transcription', {
      redis: redisConfig
    });
    
    logger.info('✅ Bull Queue 初始化完成');
    
    // Redis 連接錯誤處理
    audioQueue.on('error', (error) => {
      logger.error(`Redis/Queue 連接錯誤: ${error.message}`);
    });

    audioQueue.on('waiting', (jobId) => {
      logger.info(`任務 ${jobId} 進入等待佇列`);
    });

    audioQueue.on('active', (job) => {
      logger.info(`任務 ${job.id} 開始處理`);
    });

    audioQueue.on('completed', (job, result) => {
      logger.info(`任務 ${job.id} 完成處理`);
    });

    audioQueue.on('failed', (job, err) => {
      logger.error(`任務 ${job.id} 處理失敗: ${err.message}`);
    });

    // 設定 Queue 處理器
    audioQueue.process(async (job) => {
      return await processTranscriptionJob(job);
    });
  })
  .catch(error => {
    logger.error(`Redis 連接測試失敗: ${error.message}`);
  });

// 任務處理函數
async function processTranscriptionJob(job) {
  const { fileId, fileName, caseId, forceOpenAI } = job.data;
  
  try {
    logger.info(`🎬 開始處理轉錄任務 - Case ID: ${caseId}`);
    logger.info(`📋 任務資訊: 檔案 ${fileName}, 強制 OpenAI: ${forceOpenAI ? '是' : '否'}`);
    
    // 1. 從 Google Drive 下載音檔
    logger.info(`📥 步驟 1/4: 正在從 Google Drive 下載音檔...`);
    const localFilePath = await downloadFromGoogleDrive(fileId, fileName);
    
    let transcript = '';
    let quality = null;
    let processingMethod = 'faster-whisper';
    
    // 2. 決定使用哪種轉錄方法
    logger.info(`🤖 步驟 2/4: 選擇轉錄方法...`);
    if (forceOpenAI) {
      // 如果強制使用 OpenAI API
      logger.info('🔧 使用 OpenAI API 轉錄（強制模式）');
      const result = await transcribeWithOpenAI(localFilePath);
      transcript = result.transcript;
      quality = result.quality;
      processingMethod = 'openai-api';
    } else {
      // 先嘗試 Faster-Whisper
      logger.info('🔧 使用 Faster-Whisper 轉錄');
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
}

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

// 根路由 - 服務資訊
app.get('/', (req, res) => {
  res.json({
    service: 'Zeabur Whisper 優化轉錄服務',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      transcribe: 'POST /transcribe',
      health: 'GET /health',
      quality: 'GET /quality',
      jobStatus: 'GET /job/:jobId'
    },
    description: '專為 iPhone 音檔優化的 AI 轉錄服務，支援 Faster-Whisper 和 OpenAI API 智能降級'
  });
});

// API 路由
app.post('/transcribe', async (req, res) => {
  try {
    const { fileId, fileName, caseId, forceOpenAI } = req.body;
    
    if (!fileId || !caseId) {
      return res.status(400).json({
        error: '缺少必要參數: fileId 或 caseId'
      });
    }
    
    if (!audioQueue) {
      return res.status(503).json({
        error: 'Redis 連接尚未準備就緒，請稍後再試'
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
app.get('/health', async (req, res) => {
  const report = qualityMonitor.generateQualityReport();
  
  let queueStats = {};
  if (audioQueue) {
    try {
      queueStats = {
        waiting: await audioQueue.waiting(),
        active: await audioQueue.active(),
        completed: await audioQueue.completed(),
        failed: await audioQueue.failed()
      };
    } catch (error) {
      queueStats = { error: 'Queue stats unavailable' };
    }
  } else {
    queueStats = { status: 'Redis connection not ready' };
  }
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    queue: queueStats,
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
    if (!audioQueue) {
      return res.status(503).json({ error: 'Redis 連接尚未準備就緒' });
    }
    
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

// 診斷端點 - 測試 Google Drive 存取
app.get('/debug/check-file/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { checkFileAccess, getFileInfo } = require('./services/googleDriveService');
    
    logger.info(`開始檢查檔案存取權限: ${fileId}`);
    
    // 檢查檔案存取權限
    const hasAccess = await checkFileAccess(fileId);
    
    if (!hasAccess) {
      return res.json({
        fileId,
        hasAccess: false,
        error: '無法存取檔案或檔案不存在'
      });
    }
    
    // 取得檔案資訊
    const fileInfo = await getFileInfo(fileId);
    
    res.json({
      fileId,
      hasAccess: true,
      fileInfo: fileInfo
    });
    
  } catch (error) {
    logger.error(`檢查檔案失敗: ${error.message}`);
    res.status(500).json({
      error: error.message,
      fileId: req.params.fileId
    });
  }
});

// 診斷端點 - 測試完整轉錄流程
app.post('/debug/test-transcription', async (req, res) => {
  try {
    const { fileId, fileName, caseId } = req.body;
    
    if (!fileId || !caseId) {
      return res.status(400).json({
        error: '缺少必要參數: fileId 或 caseId'
      });
    }
    
    logger.info(`開始診斷轉錄流程 - Case ID: ${caseId}, File ID: ${fileId}`);
    
    // 步驟 1: 檢查 Google Drive 存取
    const { checkFileAccess } = require('./services/googleDriveService');
    const hasAccess = await checkFileAccess(fileId);
    
    if (!hasAccess) {
      return res.json({
        step: 1,
        success: false,
        error: '無法存取 Google Drive 檔案',
        fileId,
        caseId
      });
    }
    
    // 步驟 2: 嘗試下載檔案
    const { downloadFromGoogleDrive } = require('./services/googleDriveService');
    let localFilePath;
    
    try {
      localFilePath = await downloadFromGoogleDrive(fileId, fileName);
      logger.info(`檔案下載成功: ${localFilePath}`);
    } catch (downloadError) {
      return res.json({
        step: 2,
        success: false,
        error: `檔案下載失敗: ${downloadError.message}`,
        fileId,
        caseId
      });
    }
    
    // 步驟 3: 檢查 OpenAI API
    try {
      const testResponse = await openai.models.list();
      logger.info('OpenAI API 連接正常');
    } catch (openaiError) {
      return res.json({
        step: 3,
        success: false,
        error: `OpenAI API 連接失敗: ${openaiError.message}`,
        fileId,
        caseId
      });
    }
    
    // 步驟 4: 檢查 Google Sheets 存取
    const { checkConnection } = require('./services/googleSheetsService');
    const sheetsConnection = await checkConnection();
    
    if (!sheetsConnection.connected) {
      return res.json({
        step: 4,
        success: false,
        error: `Google Sheets 連接失敗: ${sheetsConnection.error}`,
        fileId,
        caseId
      });
    }
    
    res.json({
      success: true,
      message: '所有診斷步驟通過',
      fileId,
      caseId,
      localFilePath,
      sheetsTitle: sheetsConnection.spreadsheetTitle,
      checks: {
        googleDrive: '✅ 可存取',
        fileDownload: '✅ 下載成功',
        openaiAPI: '✅ 連接正常',
        googleSheets: '✅ 連接正常'
      }
    });
    
  } catch (error) {
    logger.error(`診斷流程失敗: ${error.message}`);
    res.status(500).json({
      error: error.message,
      step: 'unknown'
    });
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
    
    if (!audioQueue) {
      return res.status(503).json({ error: 'Redis 連接尚未準備就緒' });
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

// 進程錯誤處理
process.on('uncaughtException', (error) => {
  logger.error(`未捕捉的異常: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`未處理的 Promise 拒絕: ${reason}`);
  logger.error(`Promise: ${promise}`);
  process.exit(1);
});

// 優雅關閉
process.on('SIGTERM', () => {
  logger.info('收到 SIGTERM，正在關閉服務器...');
  if (audioQueue) {
    audioQueue.close().then(() => {
      process.exit(0);
    }).catch((error) => {
      logger.error(`關閉佇列時發生錯誤: ${error.message}`);
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', () => {
  logger.info('收到 SIGINT，正在關閉服務器...');
  if (audioQueue) {
    audioQueue.close().then(() => {
      process.exit(0);
    }).catch((error) => {
      logger.error(`關閉佇列時發生錯誤: ${error.message}`);
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
});

module.exports = app;