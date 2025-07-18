const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { nodeWhisper } = require('node-whisper');
const tmp = require('tmp');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// 針對 iPhone 錄音優化的參數
const IPHONE_OPTIMIZED_CONFIG = {
  // 使用 large 模型以獲得最佳準確度
  modelName: 'large',
  // 針對 iPhone 錄音的分塊策略
  chunkDuration: 12 * 60, // 12分鐘片段，平衡記憶體和準確度
  // 音檔預處理參數
  preprocessing: {
    bitrate: 96, // 針對 iPhone 錄音的最佳比特率
    sampleRate: 24000, // 稍高的採樣率保持細節
    channels: 1,
    // 針對 iPhone 錄音的濾波器
    filters: [
      'highpass=f=60',    // 去除極低頻雜訊
      'lowpass=f=8000',   // 保留語音頻率範圍
      'compand=0.02,0.2:-40,-40,-30,-10,-20,-8,-10,-7,-3,-3:0.1:0.1', // 動態範圍壓縮
      'speechnorm=e=12.5:r=0.00005:l=1' // 語音標準化
    ]
  },
  // Whisper 模型參數優化
  whisperOptions: {
    word_timestamps: true, // 開啟詞級時間戳提高準確度
    fp16: false, // 使用 fp32 提高穩定性
    temperature: 0.0, // 確定性輸出
    best_of: 3, // 生成3個候選結果選最佳
    beam_size: 5, // 增加搜索寬度
    patience: 2.0, // 提高搜索耐心
    length_penalty: 1.0, // 長度懲罰
    compression_ratio_threshold: 2.4,
    logprob_threshold: -1.0,
    no_speech_threshold: 0.6,
    condition_on_previous_text: true, // 利用上下文
    initial_prompt: "這是一段中文商務對話錄音，包含專業術語和人名地名。" // 中文提示
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
      .audioCodec('mp3')
      .audioBitrate(finalBitrate)
      .audioFrequency(finalSampleRate)
      .audioChannels(config.channels)
      .audioFilters(config.filters)
      .output(outputPath);
    
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
        try {
          const processedInfo = await getAudioInfo(outputPath);
          
          logger.info(`iPhone 錄音預處理完成:`);
          logger.info(`- 原始: ${audioInfo.sizeMB.toFixed(2)}MB, ${audioInfo.bitrate}bps`);
          logger.info(`- 處理後: ${processedInfo.sizeMB.toFixed(2)}MB, ${processedInfo.bitrate}bps`);
          logger.info(`- 壓縮率: ${((1 - processedInfo.sizeMB / audioInfo.sizeMB) * 100).toFixed(1)}%`);
          
          resolve(outputPath);
        } catch (error) {
          logger.error(`獲取處理後音檔資訊失敗: ${error.message}`);
          resolve(outputPath);
        }
      })
      .on('error', (err) => {
        logger.error(`iPhone 錄音預處理失敗: ${err.message}`);
        reject(err);
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
  const chunkPath = tmp.tmpNameSync({ postfix: `_chunk_${Date.now()}.mp3` });
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(startTime)
      .duration(endTime - startTime)
      .audioCodec('mp3')
      .audioBitrate(IPHONE_OPTIMIZED_CONFIG.preprocessing.bitrate)
      .audioFrequency(IPHONE_OPTIMIZED_CONFIG.preprocessing.sampleRate)
      .audioChannels(1)
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
 * 使用優化參數的 Faster-Whisper 轉錄
 */
async function transcribeWithOptimizedWhisper(audioPath, isFromiPhone = false) {
  try {
    logger.info(`開始轉錄 ${isFromiPhone ? 'iPhone 錄音' : '音檔'}: ${audioPath}`);
    
    const startTime = Date.now();
    const config = IPHONE_OPTIMIZED_CONFIG;
    
    // 針對 iPhone 錄音的特殊提示
    const initialPrompt = isFromiPhone ? 
      "這是一段來自 iPhone 的高品質中文商務對話錄音，包含專業術語、人名和地名。請準確轉錄。" :
      config.whisperOptions.initial_prompt;
    
    const transcript = await nodeWhisper(audioPath, {
      modelName: config.modelName,
      language: 'zh',
      verbose: true,
      removeWavFileAfterTranscription: true,
      withCuda: false,
      whisperOptions: {
        ...config.whisperOptions,
        initial_prompt: initialPrompt
      }
    });
    
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    
    // 計算轉錄品質指標
    const quality = assessTranscriptionQuality(transcript);
    
    logger.info(`轉錄完成:`);
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
    logger.error(`Faster-Whisper 轉錄失敗: ${error.message}`);
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
  const processedPath = path.join(tempDir.name, 'processed.mp3');
  
  try {
    logger.info(`開始轉錄流程: ${inputPath}`);
    
    // 1. 獲取音檔資訊
    const audioInfo = await getAudioInfo(inputPath);
    const isFromiPhone = audioInfo.isFromiPhone;
    
    logger.info(`音檔資訊:`);
    logger.info(`- 格式: ${audioInfo.format} (${audioInfo.codec})`);
    logger.info(`- 時長: ${(audioInfo.duration/60).toFixed(1)} 分鐘`);
    logger.info(`- 大小: ${audioInfo.sizeMB.toFixed(2)} MB`);
    logger.info(`- iPhone 錄音: ${isFromiPhone ? '是' : '否'}`);
    
    // 2. 預處理音檔
    await preprocessiPhoneAudio(inputPath, processedPath, audioInfo);
    
    // 3. 智能分割
    const processedInfo = await getAudioInfo(processedPath);
    const chunkFiles = await smartSplitAudioForiPhone(processedPath, processedInfo);
    
    // 4. 轉錄處理
    let finalTranscript = '';
    let totalQuality = { score: 0, confidence: 0 };
    
    if (chunkFiles.length === 1) {
      // 單個檔案直接轉錄
      const result = await transcribeWithOptimizedWhisper(chunkFiles[0], isFromiPhone);
      finalTranscript = result.text;
      totalQuality = result.quality;
    } else {
      // 多個片段批次處理
      const results = await processAudioChunks(chunkFiles, isFromiPhone);
      finalTranscript = results.text;
      totalQuality = results.quality;
    }
    
    // 5. 後處理
    const cleanedTranscript = cleanupTranscript(finalTranscript);
    
    logger.info(`轉錄流程完成:`);
    logger.info(`- 最終文字長度: ${cleanedTranscript.length} 字元`);
    logger.info(`- 整體品質評分: ${totalQuality.score}/100`);
    logger.info(`- 整體信心度: ${totalQuality.confidence.toFixed(2)}`);
    
    return {
      transcript: cleanedTranscript,
      quality: totalQuality,
      audioInfo: audioInfo
    };
    
  } catch (error) {
    logger.error(`轉錄流程失敗: ${error.message}`);
    throw error;
  } finally {
    // 清理臨時目錄
    try {
      tempDir.removeCallback();
    } catch (cleanupError) {
      logger.warn(`清理臨時目錄失敗: ${cleanupError.message}`);
    }
  }
}

/**
 * 處理音檔分塊
 */
async function processAudioChunks(chunkFiles, isFromiPhone) {
  const results = [];
  let totalScore = 0;
  let totalConfidence = 0;
  
  for (let i = 0; i < chunkFiles.length; i++) {
    const chunkPath = chunkFiles[i];
    
    try {
      logger.info(`處理片段 ${i + 1}/${chunkFiles.length}`);
      
      const result = await transcribeWithOptimizedWhisper(chunkPath, isFromiPhone);
      
      if (result.text && result.text.length > 0) {
        results.push(result.text);
        totalScore += result.quality.score;
        totalConfidence += result.quality.confidence;
      } else {
        logger.warning(`片段 ${i + 1} 轉錄結果為空`);
        results.push(`[片段 ${i + 1} 無法轉錄]`);
      }
      
    } catch (error) {
      logger.error(`轉錄片段 ${i + 1} 失敗: ${error.message}`);
      results.push(`[片段 ${i + 1} 轉錄失敗: ${error.message}]`);
    } finally {
      // 清理片段檔案
      try {
        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
      } catch (cleanupError) {
        logger.warn(`清理片段檔案失敗: ${cleanupError.message}`);
      }
    }
  }
  
  const avgScore = results.length > 0 ? totalScore / results.length : 0;
  const avgConfidence = results.length > 0 ? totalConfidence / results.length : 0;
  
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