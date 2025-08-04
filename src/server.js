// 載入環境變數
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const Queue = require('bull');
const fs = require('fs');
const tmp = require('tmp');
const ffmpeg = require('fluent-ffmpeg');
const { transcribeAudio, assessTranscriptionQuality, getAudioInfo, preprocessiPhoneAudio } = require('./services/transcriptionService');
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

// 使用 faster-whisper 本地轉錄，無需 OpenAI API
logger.info('使用 faster-whisper 本地轉錄服務');

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
logger.info(`- FASTER_WHISPER_MODEL: ${process.env.FASTER_WHISPER_MODEL || 'asadfgglie/faster-whisper-large-v3-zh-TW'}`);

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
      redis: redisConfig,
      // 配置佇列設定以處理長時間執行的任務
      settings: {
        stalledInterval: 300 * 1000,    // 5分鐘檢查一次是否卡住 (長音檔需要更長間隔)
        maxStalledCount: 10,            // 允許最多10次標記為卡住
        retryProcessDelay: 10 * 1000,   // 重試延遲10秒
      },
      defaultJobOptions: {
        jobId: undefined,
        removeOnComplete: 50,   // 保留最近50個完成的任務
        removeOnFail: 20,       // 保留最近20個失敗的任務
        attempts: 2,            // 預設重試2次
        backoff: {
          type: 'exponential',
          delay: 5000,          // 基礎延遲5秒
        },
      }
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

    // 設定 Queue 處理器 - 降低並發處理數量以節省記憶體
    const CONCURRENT_JOBS = process.env.CONCURRENT_JOBS || 1; // 降低到同時處理1個任務
    audioQueue.process(CONCURRENT_JOBS, async (job) => {
      return await processTranscriptionJob(job);
    });
  })
  .catch(error => {
    logger.error(`Redis 連接測試失敗: ${error.message}`);
  });

// 任務處理函數（帶重試機制和進度更新）
async function processTranscriptionJob(job) {
  const { fileId, fileName, caseId, forceOpenAI, batchIndex, totalBatchSize } = job.data;
  
  // 進度更新輔助函數
  const updateProgress = async (percentage, message) => {
    try {
      await job.progress(percentage);
      logger.info(`📊 [${caseId}] 進度 ${percentage}% - ${message}`);
      
      // 每10%更新一次 Google Sheets 進度狀態
      if (percentage % 10 === 0 || percentage >= 90) {
        const progressMessage = `轉錄進行中 (${percentage}%) - ${message}`;
        await updateGoogleSheet(caseId, progressMessage, '轉錄中', { 
          progress: percentage,
          currentStep: message 
        });
      }
    } catch (progressError) {
      logger.warn(`進度更新失敗: ${progressError.message}`);
    }
  };
  const maxRetries = 2; // 最多重試2次（總共3次嘗試）
  let lastError = null;
  let tempDir = null; // 記錄臨時目錄，用於清理
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const batchInfo = totalBatchSize ? `[批次 ${batchIndex + 1}/${totalBatchSize}] ` : '';
      
      if (attempt > 1) {
        logger.info(`🔄 ${batchInfo}重試轉錄任務 (第${attempt}次嘗試) - Case ID: ${caseId}`);
      } else {
        logger.info(`🎬 ${batchInfo}開始處理轉錄任務 - Case ID: ${caseId}`);
      }
    logger.info(`📋 任務資訊: 檔案 ${fileName}, 強制 OpenAI: ${forceOpenAI ? '是' : '否'}`);
    
    // 0. 初始化進度
    await updateProgress(0, '任務開始');
    
    // 1. 從 Google Drive 下載音檔
    await updateProgress(5, '從 Google Drive 下載音檔');
    const localFilePath = await downloadFromGoogleDrive(fileId, fileName);
    
    // 2. 分析音檔資訊
    await updateProgress(10, '分析音檔資訊');
    const audioInfo = await getAudioInfo(localFilePath);
    const isFromiPhone = audioInfo.isFromiPhone;
    
    logger.info(`🎵 音檔資訊:`);
    logger.info(`- 格式: ${audioInfo.format} (${audioInfo.codec})`);
    logger.info(`- 時長: ${(audioInfo.duration/60).toFixed(1)} 分鐘`);
    logger.info(`- 大小: ${audioInfo.sizeMB.toFixed(2)} MB`);
    logger.info(`- iPhone 錄音: ${isFromiPhone ? '是' : '否'}`);
    
    // 3. 預處理音檔（壓縮和優化音質）
    await updateProgress(15, '預處理音檔 (壓縮和優化音質)');
    const tmp = require('tmp');
    tempDir = tmp.dirSync({ unsafeCleanup: false }); // 不自動清理，供後續使用
    const processedPath = require('path').join(tempDir.name, 'processed.mp3');
    
    await preprocessiPhoneAudio(localFilePath, processedPath, audioInfo);
    
    // 4. 使用 faster-whisper 進行轉錄 (這是最耗時的步驟)
    await updateProgress(20, `開始 faster-whisper 轉錄 (預計需要 ${Math.ceil(audioInfo.duration/60)} 分鐘)`);
    logger.info('🔧 使用預處理後的音檔進行 faster-whisper 轉錄');
    
    // 建立轉錄進度回調函數
    const transcriptionProgress = (progressPercent, statusMessage) => {
      const overallProgress = 20 + Math.floor(progressPercent * 0.65); // 20% + 65% 的轉錄進度
      updateProgress(overallProgress, `轉錄進行中: ${statusMessage}`);
    };
    
    const result = await transcribeAudio(processedPath, transcriptionProgress);
    const transcript = result.transcript;
    const quality = result.quality;
    const processingMethod = 'faster-whisper-local';
    
    // 5. 記錄品質監控
    await updateProgress(90, '記錄品質監控');
    qualityMonitor.recordTranscription({
      success: true,
      caseId: caseId,
      quality: quality,
      processingMethod: processingMethod
    });
    
    // 6. 更新 Google Sheets
    await updateProgress(95, '更新 Google Sheets');
    await updateGoogleSheet(caseId, transcript, 'Completed', {
      processingMethod: processingMethod,
      qualityScore: quality.score,
      confidence: quality.confidence
    });
    
    await updateProgress(100, '轉錄任務完成');
    logger.info(`🎉 轉錄任務完成 - Case ID: ${caseId}`);
    logger.info(`📈 最終結果: 方法=${processingMethod}, 品質=${quality.score}/100, 文字長度=${transcript.length}字元`);
    
    // 清理臨時文件
    if (tempDir) {
      cleanupTempDirectory(tempDir);
    }
    
    // 強制垃圾回收釋放記憶體
    if (global.gc) {
      global.gc();
      logger.info(`🗑️ 手動觸發垃圾回收`);
    }
    
    // 記錄記憶體使用狀況
    const memUsage = process.memoryUsage();
    logger.info(`📊 記憶體使用: RSS=${Math.round(memUsage.rss/1024/1024)}MB, Heap=${Math.round(memUsage.heapUsed/1024/1024)}MB`);
    
      return { 
        success: true, 
        transcript, 
        caseId, 
        quality, 
        processingMethod 
      };
      
    } catch (error) {
      lastError = error;
      logger.error(`轉錄失敗 (第${attempt}次嘗試) - Case ID: ${caseId}, Error: ${error.message}`);
      
      // 如果還有重試次數，繼續嘗試
      if (attempt < maxRetries + 1) {
        logger.info(`⏱️ 等待 5 秒後重試...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      
      // 所有重試都失敗了
      break;
    }
  }
  
  // 所有嘗試都失敗，記錄最終失敗
  logger.error(`❌ 轉錄最終失敗 - Case ID: ${caseId}, 已重試${maxRetries}次`);
  
  // 記錄失敗
  qualityMonitor.recordTranscription({
    success: false,
    caseId: caseId,
    error: lastError.message,
    retries: maxRetries
  });
  
  // 更新狀態為轉錄失敗
  try {
    await updateGoogleSheet(caseId, `轉錄失敗 (已重試${maxRetries}次): ${lastError.message}`, '轉錄失敗');
  } catch (updateError) {
    logger.error(`更新失敗狀態失敗: ${updateError.message}`);
  }
  
  // 清理臨時文件（如果存在）
  if (tempDir) {
    cleanupTempDirectory(tempDir);
  }
  
  throw lastError;
}

// 清理臨時目錄的輔助函數
function cleanupTempDirectory(tempDir) {
  try {
    // 遞歸清理目錄中的所有文件
    const path = require('path');
    const cleanupDirectory = (dirPath) => {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            cleanupDirectory(filePath);
            fs.rmdirSync(filePath);
          } else {
            fs.unlinkSync(filePath);
          }
        }
      }
    };
    
    cleanupDirectory(tempDir.name);
    tempDir.removeCallback();
    logger.info(`🗑️ 臨時文件清理完成`);
  } catch (cleanupError) {
    logger.warn(`⚠️ 臨時文件清理失敗: ${cleanupError.message}`);
    // 如果清理失敗，嘗試使用系統的 rm 命令
    try {
      require('child_process').execSync(`rm -rf "${tempDir.name}"`, { timeout: 5000 });
      logger.info(`🗑️ 使用系統命令清理臨時文件成功`);
    } catch (rmError) {
      logger.warn(`⚠️ 系統命令清理也失敗: ${rmError.message}`);
    }
  }
}


// 根路由 - 服務資訊
app.get('/', (req, res) => {
  res.json({
    service: 'Faster-Whisper 繁體中文轉錄服務',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      transcribe: 'POST /transcribe',
      batchTranscribe: 'POST /transcribe/batch',
      health: 'GET /health',
      quality: 'GET /quality',
      jobStatus: 'GET /job/:jobId',
      batchStatus: 'POST /batch/status'
    },
    description: '專為 iPhone 音檔優化的 AI 轉錄服務，使用 faster-whisper 本地轉錄，支援繁體中文優化和批量處理'
  });
});

// API 路由

// 測試 Google Drive 下載功能
app.post('/test-download', async (req, res) => {
  try {
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing fileId parameter' 
      });
    }
    
    logger.info(`🔍 測試下載 - File ID: ${fileId}, Name: ${fileName || '未提供'}`);
    
    // 只執行下載，不進行轉錄
    const googleDriveService = require('./services/googleDriveService');
    const startTime = Date.now();
    
    const localFilePath = await googleDriveService.downloadFromGoogleDrive(fileId, fileName);
    
    const downloadTime = (Date.now() - startTime) / 1000;
    
    // 檢查檔案資訊
    const fs = require('fs');
    const fileStats = fs.statSync(localFilePath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    
    logger.info(`✅ 下載測試成功 - 檔案大小: ${fileSizeMB.toFixed(2)}MB, 下載時間: ${downloadTime}秒`);
    
    // 檢查檔案格式
    const path = require('path');
    const fileExtension = path.extname(localFilePath).toLowerCase();
    
    res.json({
      success: true,
      message: '下載測試成功',
      data: {
        localFilePath: localFilePath,
        fileSizeMB: fileSizeMB.toFixed(2),
        downloadTimeSeconds: downloadTime,
        fileExtension: fileExtension,
        originalFileName: fileName
      }
    });
    
  } catch (error) {
    logger.error(`❌ 下載測試失敗: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
      attempts: 2,            // 重試次數降低到2次
      backoff: {
        type: 'exponential',
        delay: 3000           // 增加重試延遲到3秒
      },
      delay: 1000,            // 初始延遲1秒
      timeout: 50 * 60 * 1000, // 任務超時時間：50分鐘 (60分鐘音檔需要)
      jobId: `transcribe_${caseId}_${Date.now()}` // 唯一任務ID
    });
    
    logger.info(`任務已加入佇列 - Job ID: ${job.id}, Case ID: ${caseId}`);
    
    res.status(202).json({
      message: '轉錄任務已提交',
      jobId: job.id,
      caseId,
      processingMethod: 'faster-whisper-local'
    });
    
  } catch (error) {
    logger.error(`提交任務失敗: ${error.message}`);
    res.status(500).json({
      error: '內部伺服器錯誤',
      message: error.message
    });
  }
});

// 批量轉錄端點
app.post('/transcribe/batch', async (req, res) => {
  try {
    const { files, forceOpenAI } = req.body;
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        error: '缺少必要參數: files 陣列'
      });
    }
    
    if (!audioQueue) {
      return res.status(503).json({
        error: 'Redis 連接尚未準備就緒，請稍後再試'
      });
    }
    
    const maxBatchSize = parseInt(process.env.MAX_BATCH_SIZE) || 20;
    if (files.length > maxBatchSize) {
      return res.status(400).json({
        error: `批量處理最多支持 ${maxBatchSize} 個檔案，當前: ${files.length}`
      });
    }
    
    const jobs = [];
    const errors = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      if (!file.fileId || !file.caseId) {
        errors.push({
          index: i,
          error: '缺少必要參數: fileId 或 caseId',
          file: file
        });
        continue;
      }
      
      try {
        // 為批量任務添加延遲，避免同時處理過多任務
        const delayMs = i * 1000; // 每個任務延遲1秒
        
        const job = await audioQueue.add({
          fileId: file.fileId,
          fileName: file.fileName || 'unknown_audio_file',
          caseId: file.caseId,
          forceOpenAI: forceOpenAI || false,
          batchIndex: i,
          totalBatchSize: files.length
        }, {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 5000           // 批量任務重試延遲更長
          },
          delay: delayMs,
          timeout: 60 * 60 * 1000, // 批量任務超時時間更長：60分鐘
          priority: 5 - Math.min(4, Math.floor(i / 5)), // 前面的任務優先級稍高
          jobId: `batch_${file.caseId}_${i}_${Date.now()}` // 唯一批量任務ID
        });
        
        jobs.push({
          jobId: job.id,
          caseId: file.caseId,
          fileName: file.fileName,
          batchIndex: i
        });
        
        logger.info(`批量任務 ${i + 1}/${files.length} 已加入佇列 - Job ID: ${job.id}, Case ID: ${file.caseId}`);
        
      } catch (jobError) {
        errors.push({
          index: i,
          error: jobError.message,
          file: file
        });
      }
    }
    
    logger.info(`批量轉錄任務提交完成 - 成功: ${jobs.length}, 失敗: ${errors.length}`);
    
    res.status(202).json({
      message: `批量轉錄任務已提交`,
      summary: {
        total: files.length,
        submitted: jobs.length,
        failed: errors.length
      },
      jobs: jobs,
      errors: errors.length > 0 ? errors : undefined,
      processingMethod: 'faster-whisper-local',
      estimatedProcessingTime: `約 ${Math.ceil(files.length / 3)} 分鐘 (3個並發)`
    });
    
  } catch (error) {
    logger.error(`批量提交任務失敗: ${error.message}`);
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

// 批量任務狀態監控端點
app.post('/batch/status', async (req, res) => {
  try {
    const { jobIds } = req.body;
    
    if (!jobIds || !Array.isArray(jobIds)) {
      return res.status(400).json({ error: '缺少 jobIds 陣列' });
    }
    
    if (!audioQueue) {
      return res.status(503).json({ error: 'Redis 連接尚未準備就緒' });
    }
    
    const jobStatuses = [];
    
    for (const jobId of jobIds) {
      try {
        const job = await audioQueue.getJob(jobId);
        
        if (job) {
          jobStatuses.push({
            jobId: job.id,
            caseId: job.data.caseId,
            fileName: job.data.fileName,
            state: await job.getState(),
            progress: job.progress,
            result: job.returnvalue,
            failedReason: job.failedReason,
            batchIndex: job.data.batchIndex,
            totalBatchSize: job.data.totalBatchSize
          });
        } else {
          jobStatuses.push({
            jobId: jobId,
            error: '任務不存在'
          });
        }
      } catch (jobError) {
        jobStatuses.push({
          jobId: jobId,
          error: jobError.message
        });
      }
    }
    
    // 統計概要
    const summary = {
      total: jobStatuses.length,
      completed: jobStatuses.filter(j => j.state === 'completed').length,
      active: jobStatuses.filter(j => j.state === 'active').length,
      waiting: jobStatuses.filter(j => j.state === 'waiting').length,
      failed: jobStatuses.filter(j => j.state === 'failed').length,
      delayed: jobStatuses.filter(j => j.state === 'delayed').length
    };
    
    res.json({
      summary,
      jobs: jobStatuses,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error(`取得批量任務狀態失敗: ${error.message}`);
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
      priority: 10, // 高優先權
      backoff: {
        type: 'fixed',
        delay: 1000
      }
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