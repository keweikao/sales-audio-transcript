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

// 設定 Queue - 支援 Redis 和內存模式
let audioQueue;
let useRedis = true;

// 檢查是否強制使用內存模式
if (process.env.FORCE_MEMORY_QUEUE === 'true') {
  useRedis = false;
  logger.info('🔄 強制使用內存佇列模式 (無 Redis)');
}

if (useRedis) {
  // 嘗試 Redis 配置
  let redisConfig;
  
  if (process.env.REDIS_URL) {
    redisConfig = process.env.REDIS_URL;
  } else if (process.env.REDIS_URI) {
    redisConfig = process.env.REDIS_URI;
  } else if (process.env.REDIS_CONNECTION_STRING) {
    redisConfig = process.env.REDIS_CONNECTION_STRING;
  } else {
    // 嘗試使用 Zeabur 常見的環境變數格式
    const redisHost = process.env.REDIS_HOST || process.env.ZEABUR_REDIS_HOST || 'redis';
    const redisPort = process.env.REDIS_PORT || process.env.ZEABUR_REDIS_PORT || '6379';
    const redisPassword = process.env.REDIS_PASSWORD || process.env.ZEABUR_REDIS_PASSWORD || '';
    
    if (redisPassword) {
      redisConfig = `redis://:${redisPassword}@${redisHost}:${redisPort}`;
    } else {
      redisConfig = `redis://${redisHost}:${redisPort}`;
    }
  }
  
  logger.info(`Connecting to Redis via: ${redisConfig.replace(/:([^@:]+)@/, ':****@')}`);
  
  try {
    audioQueue = new Queue('audio transcription', redisConfig);
  } catch (error) {
    logger.error(`Redis 初始化失敗: ${error.message}`);
    useRedis = false;
  }
}

// 如果 Redis 失敗，回退到內存佇列
if (!useRedis) {
  logger.info('🔄 使用內存佇列模式 (不依賴 Redis)');
  // 創建一個簡單的內存佇列實現
  const MemoryQueue = require('./services/memoryQueue');
  audioQueue = new MemoryQueue();
}

// 佇列事件處理
if (useRedis) {
  // Redis 模式的事件處理
  audioQueue.on('error', (error) => {
    logger.error(`Redis/Queue 連接錯誤: ${error.message}`);
    if (error.code === 'ECONNREFUSED') {
      logger.warn(`⚠️  Redis 連接被拒絕，考慮切換到內存佇列模式`);
      logger.warn(`可以設定環境變數 FORCE_MEMORY_QUEUE=true 使用內存佇列`);
    }
  });

  audioQueue.on('ready', () => {
    logger.info(`✅ Redis 佇列連接成功!`);
  });
} else {
  // 內存模式已經在 MemoryQueue 類中處理事件
}

// 通用任務失敗處理
audioQueue.on('failed', (job, err) => {
  logger.error(`任務失敗 Job ID: ${job.id}, 錯誤: ${err.message}`);
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
    description: '專為 iPhone 音檔優化的 AI 轉錄服務，使用 OpenAI whisper 提供高品質轉錄'
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
      processingMethod: 'openai-whisper'
    });

  } catch (error) {
    logger.error(`提交任務失敗: ${error.message}`);
    res.status(500).json({ error: '內部伺服器錯誤', message: error.message });
  }
});

// 批量轉錄端點
app.post('/transcribe/batch', async (req, res) => {
  try {
    const { files } = req.body;
    
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
          batchIndex: i,
          totalBatchSize: files.length
        }, {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000
          },
          delay: delayMs,
          timeout: 30 * 60 * 1000,  // Changed to 30 minutes timeout for batch jobs
          priority: 5 - Math.min(4, Math.floor(i / 5)) // 前面的任務優先級稍高
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
      processingMethod: 'openai-whisper',
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

// 品質檢查端點
app.post('/quality/check', (req, res) => {
  try {
    const { quality } = req.body;
    
    if (!quality) {
      return res.status(400).json({ error: '缺少品質資料' });
    }
    
    res.json({
      recommendation: 'openai-whisper',
      quality: quality,
      status: 'ok'
    });
    
  } catch (error) {
    logger.error(`品質檢查失敗: ${error.message}`);
    res.status(500).json({ error: '品質檢查失敗' });
  }
});

// 健康檢查端點
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
const server = app.listen(port, '0.0.0.0', () => {
  logger.info(`🚀 Faster-Whisper 轉錄服務 (v1.2.0) 已啟動在 port ${port}`); // Changed message
  logger.info(`📊 品質監控: 啟用`);
  logger.info(`🔧 使用 Faster-Whisper 本地轉錄`); // Changed message

  // 驗證 Python 和 Faster-Whisper 依賴
  logger.info('✅ 使用 Python Faster-Whisper 進行轉錄'); // Changed message
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