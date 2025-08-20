const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const tmp = require('tmp');
const winston = require('winston');
const { whisper } = require('whisper-node');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// 使用 Faster-Whisper 進行本地音頻轉錄
logger.info('使用 Faster-Whisper 進行音頻轉錄');

// 針對 iPhone 錄音優化的參數
const IPHONE_OPTIMIZED_CONFIG = {
  // 使用 base 模型以獲得更快速度
  modelName: 'base',
  // 針對 iPhone 錄音的分塊策略
  chunkDuration: 8 * 60, // 8分鐘片段，減少單個片段處理時間
  // 音檔預處理參數
  preprocessing: {
    bitrate: 96, // 針對 iPhone 錄音的最佳比特率
    sampleRate: 24000, // 稍高的採樣率保持細節
    channels: 1,
    // 簡化濾波器，避免複雜濾鏡鏈問題
    filters: [
      'highpass=f=80',    // 去除低頻雜訊
      'lowpass=f=8000'    // 保留語音頻率範圍
    ]
  },
  // Faster-Whisper 參數配置
  whisperOptions: {
    language: 'zh',
    model: 'base',
    temperature: 0.0
  }
};

/**
 * 獲取音檔詳細資訊
 */
async function getAudioInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      
      const format = metadata.format;
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      
      resolve({
        duration: format.duration,
        sizeMB: format.size / (1024 * 1024),
        bitrate: format.bit_rate,
        format: format.format_name,
        codec: audioStream?.codec_name,
        sampleRate: audioStream?.sample_rate,
        channels: audioStream?.channels,
        isFromiPhone: detectiPhoneRecording(metadata)
      });
    });
  });
}

/**
 * 檢測是否為 iPhone 錄音
 */
function detectiPhoneRecording(metadata) {
  const format = metadata.format;
  const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
  
  // iPhone 錄音特徵
  const isiPhoneFormat = format.format_name?.includes('mov') || 
                        format.format_name?.includes('mp4') ||
                        format.format_name?.includes('m4a');
  
  const isiPhoneCodec = audioStream?.codec_name === 'aac';
  
  const tags = format.tags || {};
  const isiPhoneMetadata = tags.encoder?.includes('iPhone') || 
                          tags.comment?.includes('iPhone') ||
                          tags.creation_time; // iPhone 通常有創建時間
  
  return isiPhoneFormat && isiPhoneCodec;
}

/**
 * iPhone 錄音專用預處理
 */
async function preprocessiPhoneAudio(inputPath, outputPath, audioInfo) {
  return new Promise((resolve, reject) => {
    logger.info(`iPhone 錄音預處理開始: ${inputPath}`);
    
    // 設定超時機制 (10分鐘) - 適應長音檔
    const timeout = setTimeout(() => {
      logger.error('iPhone 錄音預處理超時');
      reject(new Error('Audio preprocessing timeout'));
    }, 10 * 60 * 1000);
    
    const config = IPHONE_OPTIMIZED_CONFIG.preprocessing;
    
    // 根據原始音檔品質調整參數
    let finalBitrate = config.bitrate;
    let finalSampleRate = config.sampleRate;
    
    // 如果原始音檔品質很高，保持較高設定
    if (audioInfo.bitrate > 256000) {
      finalBitrate = 128;
      finalSampleRate = 32000;
    } else if (audioInfo.bitrate > 128000) {
      finalBitrate = 96;
      finalSampleRate = 24000;
    }
    
    const ffmpegCommand = ffmpeg(inputPath)
      .audioCodec('pcm_s16le')  // WAV format for whisper-node
      .audioBitrate(finalBitrate)
      .audioFrequency(16000)    // whisper-node requires 16kHz
      .audioChannels(1)         // Mono for whisper-node
      .audioFilters(config.filters)
      .format('wav')            // Force WAV output
      .output(outputPath.replace('.mp3', '.wav'));
    
    ffmpegCommand
      .on('start', (commandLine) => {
        logger.info(`FFmpeg 處理開始: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          logger.info(`預處理進度: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', async () => {
        clearTimeout(timeout);
        try {
          const processedInfo = await getAudioInfo(outputPath);
          
          logger.info(`iPhone 錄音預處理完成:`);
          logger.info(`- 原始: ${audioInfo.sizeMB.toFixed(2)}MB, ${audioInfo.bitrate}bps`);
          logger.info(`- 處理後: ${processedInfo.sizeMB.toFixed(2)}MB, ${processedInfo.bitrate}bps`);
          logger.info(`- 壓縮率: ${((1 - processedInfo.sizeMB / audioInfo.sizeMB) * 100).toFixed(1)}%`);
          
          resolve(outputPath.replace('.mp3', '.wav'));
        } catch (error) {
          logger.error(`獲取處理後音檔資訊失敗: ${error.message}`);
          resolve(outputPath.replace('.mp3', '.wav'));
        }
      })
      .on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`iPhone 錄音預處理失敗: ${err.message}`);
        
        // 如果是編解碼器問題，直接返回原始檔案
        if (err.message.includes('codec') || err.message.includes('mp3')) {
          logger.warn('編解碼器不可用，跳過預處理，使用原始檔案');
          resolve(inputPath);
        } else {
          reject(err);
        }
      })
      .run();
  });
}

/**
 * 智能分割音檔（針對 iPhone 錄音優化）
 */
async function smartSplitAudioForiPhone(inputPath, audioInfo) {
  const totalDuration = audioInfo.duration;
  const chunkDuration = IPHONE_OPTIMIZED_CONFIG.chunkDuration;
  
  // iPhone 錄音品質高，可以使用較長片段
  if (totalDuration <= chunkDuration * 1.5) {
    logger.info(`iPhone 錄音時長 ${(totalDuration/60).toFixed(1)} 分鐘，直接處理`);
    return [inputPath];
  }
  
  // 基於語音停頓的智能分割
  const pauseDetectionChunks = await splitByPauses(inputPath, chunkDuration);
  
  if (pauseDetectionChunks.length > 0) {
    logger.info(`基於語音停頓分割為 ${pauseDetectionChunks.length} 個片段`);
    return pauseDetectionChunks;
  }
  
  // 回到時間分割
  return await splitByTime(inputPath, chunkDuration);
}

/**
 * 基於語音停頓的智能分割
 */
async function splitByPauses(inputPath, maxChunkDuration) {
  try {
    // 使用 ffmpeg 檢測靜音段
    const silenceDetection = await detectSilences(inputPath);
    
    if (silenceDetection.length === 0) {
      return []; // 沒有檢測到靜音，使用時間分割
    }
    
    const chunks = [];
    let currentStart = 0;
    
    for (const silence of silenceDetection) {
      const chunkDuration = silence.start - currentStart;
      
      if (chunkDuration >= maxChunkDuration) {
        // 在這個靜音點分割
        const chunkPath = await extractChunk(inputPath, currentStart, silence.start);
        chunks.push(chunkPath);
        currentStart = silence.end;
      }
    }
    
    // 處理最後一個片段
    const audioInfo = await getAudioInfo(inputPath);
    if (currentStart < audioInfo.duration) {
      const chunkPath = await extractChunk(inputPath, currentStart, audioInfo.duration);
      chunks.push(chunkPath);
    }
    
    return chunks;
    
  } catch (error) {
    logger.warn(`基於停頓分割失敗，使用時間分割: ${error.message}`);
    return [];
  }
}

/**
 * 檢測靜音段
 */
async function detectSilences(inputPath) {
  return new Promise((resolve, reject) => {
    let silences = [];
    
    ffmpeg(inputPath)
      .audioFilters('silencedetect=n=-30dB:d=1.0') // 檢測1秒以上的靜音
      .format('null')
      .output('-')
      .on('stderr', (stderrLine) => {
        // 解析 silencedetect 輸出
        const silenceStart = stderrLine.match(/silence_start: ([\d.]+)/);
        const silenceEnd = stderrLine.match(/silence_end: ([\d.]+)/);
        
        if (silenceStart) {
          silences.push({ start: parseFloat(silenceStart[1]), end: null });
        }
        if (silenceEnd && silences.length > 0) {
          silences[silences.length - 1].end = parseFloat(silenceEnd[1]);
        }
      })
      .on('end', () => {
        // 過濾出有效的靜音段
        const validSilences = silences.filter(s => s.end !== null && (s.end - s.start) >= 1.0);
        resolve(validSilences);
      })
      .on('error', reject)
      .run();
  });
}

/**
 * 提取音檔片段
 */
async function extractChunk(inputPath, startTime, endTime) {
  const chunkPath = tmp.tmpNameSync({ postfix: `_chunk_${Date.now()}.wav` });
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(startTime)
      .duration(endTime - startTime)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)  // whisper-node requires 16kHz
      .audioChannels(1)
      .format('wav')
      .output(chunkPath)
      .on('end', () => resolve(chunkPath))
      .on('error', reject)
      .run();
  });
}

/**
 * 時間分割
 */
async function splitByTime(inputPath, chunkDuration) {
  const audioInfo = await getAudioInfo(inputPath);
  const totalDuration = audioInfo.duration;
  const numChunks = Math.ceil(totalDuration / chunkDuration);
  
  const chunks = [];
  
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDuration;
    const endTime = Math.min((i + 1) * chunkDuration, totalDuration);
    
    const chunkPath = await extractChunk(inputPath, startTime, endTime);
    chunks.push(chunkPath);
    
    logger.info(`創建時間片段 ${i + 1}/${numChunks}: ${(startTime/60).toFixed(1)}-${(endTime/60).toFixed(1)} 分鐘`);
  }
  
  return chunks;
}

/**
 * 確保 whisper 模型已初始化
 */
async function ensureWhisperModelInitialized() {
  try {
    const modelPath = path.join(__dirname, '../../models/ggml-base.bin');
    const modelExists = fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1000;
    
    if (!modelExists) {
      logger.info('🔄 模型不存在，嘗試運行時初始化...');
      
      // 嘗試運行初始化腳本
      try {
        const { initializeWhisperNode } = require('../../init-whisper');
        await initializeWhisperNode();
      } catch (initError) {
        logger.warn(`初始化腳本失敗: ${initError.message}`);
        
        // 最後的備用方案 - 直接下載
        const { execSync } = require('child_process');
        try {
          execSync('curl -L -o models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', {
            cwd: path.join(__dirname, '../..'),
            timeout: 60000
          });
          logger.info('✅ 備用下載成功');
        } catch (downloadError) {
          logger.error(`所有模型初始化方法都失敗: ${downloadError.message}`);
          throw new Error('Unable to initialize whisper model');
        }
      }
    }
  } catch (error) {
    logger.warn(`模型初始化檢查失敗: ${error.message}`);
  }
}

/**
 * 使用優化參數的 Faster-Whisper 轉錄
 */
async function transcribeWithOptimizedWhisper(audioPath, isFromiPhone = false, progressCallback = null) {
  try {
    logger.info(`開始轉錄 ${isFromiPhone ? 'iPhone 錄音' : '音檔'}: ${audioPath}`);
    
    // 確保模型已初始化
    await ensureWhisperModelInitialized();
    
    const startTime = Date.now();
    const config = IPHONE_OPTIMIZED_CONFIG;
    
    // 獲取音檔資訊
    const audioInfo = await getAudioInfo(audioPath);
    
    // 使用 Faster-Whisper 進行本地轉錄
    logger.info('🔄 使用 whisper-node 進行本地轉錄');
    
    if (progressCallback) {
      progressCallback(50, '正在轉錄...');
    }
    
    // 確保音檔是 .wav 格式
    let finalAudioPath = audioPath;
    if (!audioPath.endsWith('.wav')) {
      finalAudioPath = audioPath.replace(/\.[^.]+$/, '.wav');
    }
    
    // 執行轉錄 - whisper-node 參數格式
    const transcriptResult = await whisper(finalAudioPath, {
      modelName: config.whisperOptions.model,
      language: config.whisperOptions.language,
      gen_file_txt: false,
      gen_file_subtitle: false,
      gen_file_vtt: false,
      word_timestamps: false
    });
    
    // 處理 whisper-node 的回傳格式 (array of segments)
    let transcript = '';
    if (Array.isArray(transcriptResult)) {
      transcript = transcriptResult.map(segment => segment.speech || segment.text || '').join(' ');
    } else if (typeof transcriptResult === 'string') {
      transcript = transcriptResult;
    } else if (transcriptResult && transcriptResult.text) {
      transcript = transcriptResult.text;
    } else {
      transcript = String(transcriptResult || '');
    }
    
    logger.info(`🔍 轉錄結果類型: ${typeof transcriptResult}`);
    logger.info(`🔍 轉錄結果內容: ${transcript.substring(0, 100)}...`);
    
    if (!transcript || transcript.trim().length === 0) {
      throw new Error('轉錄結果為空');
    }
    
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    
    // 計算轉錄品質指標
    const quality = assessTranscriptionQuality(transcript);
    
    if (progressCallback) {
      progressCallback(100, '轉錄完成');
    }
    
    logger.info(`🎯 轉錄進度: 100% - 轉錄完成`);
    logger.info(`✅ 轉錄成功完成:`);
    logger.info(`- 處理時間: ${processingTime.toFixed(2)} 秒`);
    logger.info(`- 文字長度: ${transcript.length} 字元`);
    logger.info(`- 品質評分: ${quality.score}/100`);
    logger.info(`- 信心度: ${quality.confidence.toFixed(2)}`);
    
    return {
      text: transcript.trim(),
      processingTime: processingTime,
      quality: quality
    };
    
  } catch (error) {
    logger.error(`❌ Faster-Whisper 轉錄失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 評估轉錄品質
 */
function assessTranscriptionQuality(transcript) {
  let score = 100;
  let confidence = 1.0;
  
  // 基本品質檢查
  if (transcript.length < 10) {
    score -= 50;
    confidence -= 0.5;
  }
  
  // 檢查是否包含大量重複文字
  const repetitionRatio = checkRepetition(transcript);
  if (repetitionRatio > 0.3) {
    score -= 30;
    confidence -= 0.3;
  }
  
  // 檢查標點符號合理性
  const punctuationScore = checkPunctuation(transcript);
  score += punctuationScore;
  
  // 檢查中文字元比例
  const chineseRatio = checkChineseRatio(transcript);
  if (chineseRatio < 0.7) {
    score -= 20;
    confidence -= 0.2;
  }
  
  return {
    score: Math.max(0, Math.min(100, score)),
    confidence: Math.max(0, Math.min(1, confidence)),
    repetitionRatio: repetitionRatio,
    chineseRatio: chineseRatio
  };
}

/**
 * 檢查重複內容
 */
function checkRepetition(text) {
  const words = text.split(/\s+/);
  const wordCount = {};
  
  words.forEach(word => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  const repeatedWords = Object.values(wordCount).filter(count => count > 3);
  return repeatedWords.length / words.length;
}

/**
 * 檢查標點符號
 */
function checkPunctuation(text) {
  const punctuationMarks = text.match(/[。！？，、；：]/g) || [];
  const expectedPunctuation = text.length / 50; // 估計應該有的標點數量
  
  const ratio = punctuationMarks.length / expectedPunctuation;
  
  if (ratio > 0.8 && ratio < 1.5) {
    return 10; // 標點符號合理
  } else if (ratio > 0.5 && ratio < 2.0) {
    return 5; // 標點符號可接受
  } else {
    return -10; // 標點符號異常
  }
}

/**
 * 檢查中文字元比例
 */
function checkChineseRatio(text) {
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) || [];
  const totalChars = text.replace(/\s/g, '').length;
  
  return totalChars > 0 ? chineseChars.length / totalChars : 0;
}

/**
 * 主要轉錄函數
 */
async function transcribeAudio(inputPath) {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });
  const processedPath = path.join(tempDir.name, 'processed.wav');
  
  try {
    logger.info(`🚀 開始轉錄流程: ${inputPath}`);
    logger.info(`📊 整體進度: 0% - 初始化轉錄流程`);
    
    // 1. 獲取音檔資訊
    logger.info(`📊 整體進度: 5% - 正在分析音檔資訊...`);
    const audioInfo = await getAudioInfo(inputPath);
    const isFromiPhone = audioInfo.isFromiPhone;
    
    logger.info(`🎵 音檔資訊:`);
    logger.info(`- 格式: ${audioInfo.format} (${audioInfo.codec})`);
    logger.info(`- 時長: ${(audioInfo.duration/60).toFixed(1)} 分鐘`);
    logger.info(`- 大小: ${audioInfo.sizeMB.toFixed(2)} MB`);
    logger.info(`- iPhone 錄音: ${isFromiPhone ? '是' : '否'}`);
    
    // 2. 預處理音檔
    logger.info(`📊 整體進度: 15% - 正在預處理音檔...`);
    await preprocessiPhoneAudio(inputPath, processedPath, audioInfo);
    
    // 3. 智能分割
    logger.info(`📊 整體進度: 25% - 正在智能分割音檔...`);
    const processedInfo = await getAudioInfo(processedPath);
    const chunkFiles = await smartSplitAudioForiPhone(processedPath, processedInfo);
    
    logger.info(`🔄 分割結果: ${chunkFiles.length} 個片段`);
    
    // 4. 轉錄處理
    logger.info(`📊 整體進度: 30% - 開始轉錄處理...`);
    let finalTranscript = '';
    let totalQuality = { score: 0, confidence: 0 };
    
    if (chunkFiles.length === 1) {
      // 單個檔案直接轉錄
      logger.info(`📊 整體進度: 35% - 單檔轉錄模式`);
      
      const progressCallback = (percent, message) => {
        const overallProgress = 35 + (percent * 0.55); // 35% 到 90%
        logger.info(`📊 整體進度: ${overallProgress.toFixed(0)}% - ${message}`);
      };
      
      const result = await transcribeWithOptimizedWhisper(chunkFiles[0], isFromiPhone, progressCallback);
      finalTranscript = result.text;
      totalQuality = result.quality;
    } else {
      // 多個片段批次處理
      logger.info(`📊 整體進度: 35% - 多檔批次轉錄模式 (${chunkFiles.length} 個片段)`);
      
      const results = await processAudioChunks(chunkFiles, isFromiPhone, (current, total) => {
        const chunkProgress = 35 + ((current / total) * 55); // 35% 到 90%
        logger.info(`📊 整體進度: ${chunkProgress.toFixed(0)}% - 正在處理片段 ${current}/${total}`);
      });
      
      finalTranscript = results.text;
      totalQuality = results.quality;
    }
    
    // 5. 後處理
    logger.info(`📊 整體進度: 95% - 正在後處理轉錄結果...`);
    const cleanedTranscript = cleanupTranscript(finalTranscript);
    
    logger.info(`📊 整體進度: 100% - 轉錄流程完成！`);
    logger.info(`🎉 轉錄流程成功完成:`);
    logger.info(`- 最終文字長度: ${cleanedTranscript.length} 字元`);
    logger.info(`- 整體品質評分: ${totalQuality.score}/100`);
    logger.info(`- 整體信心度: ${totalQuality.confidence.toFixed(2)}`);
    
    return {
      transcript: cleanedTranscript,
      quality: totalQuality,
      audioInfo: audioInfo,
      processedFilePath: processedPath  // 提供預處理後的檔案路徑
    };
    
  } catch (error) {
    logger.error(`❌ 轉錄流程失敗: ${error.message}`);
    throw error;
  } finally {
    // 清理臨時目錄以節省空間
    try {
      if (tempDir && tempDir.removeCallback) {
        tempDir.removeCallback();
        logger.info(`🗑️ 已清理臨時目錄: ${tempDir.name}`);
      }
    } catch (cleanupError) {
      logger.warn(`⚠️ 清理臨時目錄失敗: ${cleanupError.message}`);
    }
  }
}

/**
 * 處理音檔分塊
 */
async function processAudioChunks(chunkFiles, isFromiPhone, progressCallback = null) {
  const results = [];
  let totalScore = 0;
  let totalConfidence = 0;
  
  for (let i = 0; i < chunkFiles.length; i++) {
    const chunkPath = chunkFiles[i];
    
    try {
      logger.info(`🎯 處理片段 ${i + 1}/${chunkFiles.length}`);
      
      // 回報進度
      if (progressCallback) {
        progressCallback(i + 1, chunkFiles.length);
      }
      
      const chunkProgressCallback = (percent, message) => {
        const chunkPercent = (i / chunkFiles.length) * 100 + (percent / chunkFiles.length);
        logger.info(`📊 片段 ${i + 1} 進度: ${percent}% - ${message}`);
      };
      
      const result = await transcribeWithOptimizedWhisper(chunkPath, isFromiPhone, chunkProgressCallback);
      
      if (result.text && result.text.length > 0) {
        results.push(result.text);
        totalScore += result.quality.score;
        totalConfidence += result.quality.confidence;
        logger.info(`✅ 片段 ${i + 1} 轉錄成功: ${result.text.length} 字元`);
      } else {
        logger.warn(`⚠️ 片段 ${i + 1} 轉錄結果為空`);
        results.push(`[片段 ${i + 1} 無法轉錄]`);
      }
      
    } catch (error) {
      logger.error(`❌ 轉錄片段 ${i + 1} 失敗: ${error.message}`);
      results.push(`[片段 ${i + 1} 轉錄失敗: ${error.message}]`);
    } finally {
      // 清理片段檔案
      try {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
      } catch (cleanupError) {
        logger.warn(`⚠️ 清理片段檔案失敗: ${cleanupError.message}`);
      }
    }
  }
  
  const avgScore = results.length > 0 ? totalScore / results.length : 0;
  const avgConfidence = results.length > 0 ? totalConfidence / results.length : 0;
  
  logger.info(`🎉 所有片段處理完成: ${results.length} 個片段`);
  
  return {
    text: results.join('\n\n'),
    quality: {
      score: avgScore,
      confidence: avgConfidence
    }
  };
}

/**
 * 清理轉錄文字
 */
function cleanupTranscript(transcript) {
  return transcript
    .replace(/\[\s*\]/g, '') // 移除空白標記
    .replace(/\s+/g, ' ') // 合併多個空白
    .replace(/\n\s*\n\s*\n/g, '\n\n') // 合併多個換行
    .replace(/([。！？])\s*([。！？])/g, '$1$2') // 合併重複標點
    .trim();
}

module.exports = {
  transcribeAudio,
  getAudioInfo,
  preprocessiPhoneAudio,
  assessTranscriptionQuality
};