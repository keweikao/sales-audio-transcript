const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const tmp = require("tmp");
const winston = require("winston");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});

// 使用 faster-whisper 進行本地轉錄
logger.info("使用 faster-whisper 進行本地音頻轉錄");

// 針對 iPhone 錄音優化的參數
const IPHONE_OPTIMIZED_CONFIG = {
  // 緊急使用 small 模型最小化記憶體使用
  modelName: "small",
  // 緊急減少分塊時長以最小化記憶體使用
  chunkDuration: 6 * 60, // 6分鐘片段，最小化記憶體使用
  // 音檔預處理參數
  preprocessing: {
    bitrate: 96, // 針對 iPhone 錄音的最佳比特率
    sampleRate: 24000, // 稍高的採樣率保持細節
    channels: 1,
    // 緊急簡化濾波器，最小化處理負擔
    filters: [
      "volume=0.8", // 僅調整音量，避免複雜濾波
    ],
  },
  // faster-whisper 參數配置
  whisperOptions: {
    model: "small", // 緊急降級到 small 模型最小化記憶體
    language: "zh",
    initial_prompt: "以下是一段繁體中文語音內容的轉錄：", // 強制繁體中文輸出
    word_timestamps: false,
    vad_filter: true,
    vad_parameters: {
      threshold: 0.5,
      min_speech_duration_ms: 250,
      max_speech_duration_s: 30,
      min_silence_duration_ms: 2000,
      window_size_samples: 1024,
      speech_pad_ms: 400
    }
  },
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
      const audioStream = metadata.streams.find(
        (s) => s.codec_type === "audio",
      );

      resolve({
        duration: format.duration,
        sizeMB: format.size / (1024 * 1024),
        bitrate: format.bit_rate,
        format: format.format_name,
        codec: audioStream?.codec_name,
        sampleRate: audioStream?.sample_rate,
        channels: audioStream?.channels,
        isFromiPhone: detectiPhoneRecording(metadata),
      });
    });
  });
}

/**
 * 檢測是否為 iPhone 錄音
 */
function detectiPhoneRecording(metadata) {
  const format = metadata.format;
  const audioStream = metadata.streams.find((s) => s.codec_type === "audio");

  // iPhone 錄音特徵
  const isiPhoneFormat =
    format.format_name?.includes("mov") ||
    format.format_name?.includes("mp4") ||
    format.format_name?.includes("m4a");

  const isiPhoneCodec = audioStream?.codec_name === "aac";

  const tags = format.tags || {};
  const isiPhoneMetadata =
    tags.encoder?.includes("iPhone") ||
    tags.comment?.includes("iPhone") ||
    tags.creation_time; // iPhone 通常有創建時間

  return isiPhoneFormat && isiPhoneCodec;
}

/**
 * iPhone 錄音專用預處理
 */
async function preprocessiPhoneAudio(inputPath, outputPath, audioInfo) {
  return new Promise((resolve, reject) => {
    logger.info(`iPhone 錄音預處理開始: ${inputPath}`);

    // 設定超時機制 (5分鐘)
    const timeout = setTimeout(
      () => {
        logger.error("iPhone 錄音預處理超時");
        reject(new Error("Audio preprocessing timeout"));
      },
      5 * 60 * 1000,
    );

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
      .audioCodec("libmp3lame")
      .audioBitrate(finalBitrate)
      .audioFrequency(finalSampleRate)
      .audioChannels(config.channels)
      .audioFilters(config.filters)
      .output(outputPath);

    ffmpegCommand
      .on("start", (commandLine) => {
        logger.info(`FFmpeg 處理開始: ${commandLine}`);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
          logger.info(`預處理進度: ${Math.round(progress.percent)}%`);
        }
      })
      .on("end", async () => {
        clearTimeout(timeout);
        try {
          const processedInfo = await getAudioInfo(outputPath);

          logger.info(`iPhone 錄音預處理完成:`);
          logger.info(
            `- 原始: ${audioInfo.sizeMB.toFixed(2)}MB, ${audioInfo.bitrate}bps`,
          );
          logger.info(
            `- 處理後: ${processedInfo.sizeMB.toFixed(2)}MB, ${processedInfo.bitrate}bps`,
          );
          logger.info(
            `- 壓縮率: ${((1 - processedInfo.sizeMB / audioInfo.sizeMB) * 100).toFixed(1)}%`,
          );

          resolve(outputPath);
        } catch (error) {
          logger.error(`獲取處理後音檔資訊失敗: ${error.message}`);
          resolve(outputPath);
        }
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        logger.error(`iPhone 錄音預處理失敗: ${err.message}`);

        // 如果是編解碼器問題，直接返回原始檔案
        if (err.message.includes("codec") || err.message.includes("mp3")) {
          logger.warn("編解碼器不可用，跳過預處理，使用原始檔案");
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
    logger.info(
      `iPhone 錄音時長 ${(totalDuration / 60).toFixed(1)} 分鐘，直接處理`,
    );
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
        const chunkPath = await extractChunk(
          inputPath,
          currentStart,
          silence.start,
        );
        chunks.push(chunkPath);
        currentStart = silence.end;
      }
    }

    // 處理最後一個片段
    const audioInfo = await getAudioInfo(inputPath);
    if (currentStart < audioInfo.duration) {
      const chunkPath = await extractChunk(
        inputPath,
        currentStart,
        audioInfo.duration,
      );
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
      .audioFilters("silencedetect=n=-30dB:d=1.0") // 檢測1秒以上的靜音
      .format("null")
      .output("-")
      .on("stderr", (stderrLine) => {
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
      .on("end", () => {
        // 過濾出有效的靜音段
        const validSilences = silences.filter(
          (s) => s.end !== null && s.end - s.start >= 1.0,
        );
        resolve(validSilences);
      })
      .on("error", reject)
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
      .audioCodec("libmp3lame")
      .audioBitrate(IPHONE_OPTIMIZED_CONFIG.preprocessing.bitrate)
      .audioFrequency(IPHONE_OPTIMIZED_CONFIG.preprocessing.sampleRate)
      .audioChannels(1)
      .output(chunkPath)
      .on("end", () => resolve(chunkPath))
      .on("error", reject)
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

    logger.info(
      `創建時間片段 ${i + 1}/${numChunks}: ${(startTime / 60).toFixed(1)}-${(endTime / 60).toFixed(1)} 分鐘`,
    );
  }

  return chunks;
}

/**
 * 使用 faster-whisper 進行轉錄
 */
async function transcribeWithFasterWhisper(
  audioPath,
  isFromiPhone = false,
  progressCallback = null,
) {
  const startTime = Date.now();
  let tempScriptPath = null;

  try {
    logger.info(
      `開始轉錄 ${isFromiPhone ? "iPhone 錄音" : "音檔"}: ${audioPath}`,
    );

    const config = IPHONE_OPTIMIZED_CONFIG;

    // 步驟 1: 獲取音檔資訊
    if (progressCallback) {
      progressCallback(10, "分析音檔資訊");
    }

    const audioInfo = await getAudioInfo(audioPath);
    logger.info("🔄 使用 faster-whisper 本地轉錄");

    // 步驟 2: 準備 Python 轉錄腳本
    if (progressCallback) {
      progressCallback(20, "準備轉錄腳本");
    }

    const whisperOptions = config.whisperOptions;
    const pythonPath = process.env.VIRTUAL_ENV 
      ? `${process.env.VIRTUAL_ENV}/bin/python` 
      : '/opt/venv/bin/python';

    // 創建臨時 Python 腳本文件
    tempScriptPath = `/tmp/whisper_script_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.py`;
    
    // 將 JavaScript 布林值轉換為 Python 布林值
    const pythonWordTimestamps = whisperOptions.word_timestamps ? 'True' : 'False';
    const pythonVadFilter = whisperOptions.vad_filter ? 'True' : 'False';
    
    const pythonScript = [
      'import sys',
      'import gc',
      'import os',
      'import traceback',
      '',
      'try:',
      '    from faster_whisper import WhisperModel',
      '    print("✅ faster-whisper 模組載入成功", file=sys.stderr)',
      '',
      '    # 檢查音檔是否存在',
      `    audio_path = "${audioPath}"`,
      '    if not os.path.exists(audio_path):',
      '        raise FileNotFoundError(f"音檔不存在: {audio_path}")',
      '    print(f"✅ 音檔存在: {audio_path}", file=sys.stderr)',
      '',
      '    # 初始化模型 (優化記憶體使用)',
      '    print("🔄 正在載入模型...", file=sys.stderr)',
      `    model = WhisperModel(`,
      `        "${whisperOptions.model}",`,
      `        device="cpu",`,
      `        compute_type="int8",  # 使用 int8 減少記憶體使用`,
      `        cpu_threads=1,       # 單線程最小化資源`,
      `        num_workers=1,       # 單一工作線程`,
      `        local_files_only=False  # 允許下載但節約記憶體`,
      `    )`,
      '    print("✅ 模型載入成功", file=sys.stderr)',
      '',
      '    # 轉錄音檔',
      '    print("🔄 開始轉錄...", file=sys.stderr)',
      '    segments, info = model.transcribe(',
      `        audio_path,`,
      `        language="${whisperOptions.language}",`,
      `        initial_prompt="${whisperOptions.initial_prompt}",`,
      `        word_timestamps=${pythonWordTimestamps},`,
      `        vad_filter=${pythonVadFilter},`,
      `        beam_size=1,         # 降低 beam size 減少記憶體`,
      `        best_of=1           # 只生成一個結果`,
      '    )',
      '    print("✅ 轉錄完成", file=sys.stderr)',
      '',
      '    # 輸出結果',
      '    result = "".join([segment.text for segment in segments])',
      '    print(f"🔍 轉錄結果長度: {len(result)} 字元", file=sys.stderr)',
      '    ',
      '    # 確保結果不為空',
      '    if not result or len(result.strip()) == 0:',
      '        print("⚠️ 轉錄結果為空", file=sys.stderr)',
      '        result = "[轉錄結果為空]"',
      '    ',
      '    # 輸出到 stdout (這是 Node.js 讀取的部分)',
      '    sys.stdout.write(result)',
      '    sys.stdout.flush()  # 確保輸出被寫入',
      '    print("\\n✅ 結果已輸出到 stdout", file=sys.stderr)',
      '',
      '    # 積極清理記憶體',
      '    try:',
      '        del model',
      '        del segments', 
      '        gc.collect()  # 第一次清理',
      '        gc.collect()  # 第二次確保清理', 
      '        gc.collect()  # 第三次積極清理',
      '        print("✅ 積極記憶體清理完成", file=sys.stderr)',
      '    except Exception as cleanup_error:',
      '        print(f"⚠️ 記憶體清理失敗: {cleanup_error}", file=sys.stderr)',
      '    ',
      '    print("🎉 Python 腳本執行完成", file=sys.stderr)',
      '    sys.exit(0)  # 明確成功退出',
      '',
      'except Exception as e:',
      '    print(f"❌ Python 腳本執行失敗: {str(e)}", file=sys.stderr)',
      '    print(f"❌ 錯誤類型: {type(e).__name__}", file=sys.stderr)',
      '    traceback.print_exc(file=sys.stderr)',
      '    sys.exit(1)  # 明確失敗退出'
    ].join('\n');

    // 寫入腳本文件
    require('fs').writeFileSync(tempScriptPath, pythonScript, 'utf8');
    logger.info(`Python 轉錄腳本已創建: ${tempScriptPath}`);
    
    // 調試模式：記錄腳本內容
    const debugMode = process.env.DEBUG_MODE === 'true' || process.env.NODE_ENV === 'development';
    if (debugMode) {
      logger.info(`Python 腳本內容:\n${pythonScript}`);
    }

    // 步驟 3: 執行轉錄
    if (progressCallback) {
      progressCallback(40, "執行 faster-whisper 轉錄");
    }

    const command = `${pythonPath} "${tempScriptPath}"`;
    logger.info(`執行轉錄命令: ${command}`);

    const { stdout, stderr } = await execAsync(command, {
      timeout: 120000, // 緊急降低到2分鐘超時
      maxBuffer: 1024 * 1024 * 2, // 緊急降低到2MB buffer
      encoding: 'utf8',
      killSignal: 'SIGTERM' // 明確終止信號
    });

    // 詳細記錄 Python 執行結果
    logger.info(`Python 執行完成 - stdout 長度: ${stdout ? stdout.length : 0}, stderr 長度: ${stderr ? stderr.length : 0}`);
    
    // 處理 stderr 輸出（包含錯誤和警告信息）
    if (stderr) {
      if (stderr.includes('ERROR') || stderr.includes('Traceback') || stderr.includes('Exception')) {
        logger.error(`Python 執行錯誤: ${stderr}`);
        throw new Error(`Python 腳本執行失敗: ${stderr}`);
      } else if (stderr.includes('WARNING') || stderr.includes('UserWarning')) {
        logger.warn(`Python 警告訊息: ${stderr}`);
      } else {
        // 記錄所有其他 stderr 輸出以便調試
        logger.info(`Python stderr 輸出: ${stderr}`);
      }
    }

    // 步驟 4: 處理轉錄結果
    if (progressCallback) {
      progressCallback(70, "處理轉錄結果");
    }

    const transcript = stdout ? stdout.trim() : '';
    
    logger.info(`Node.js 收到的 stdout: "${transcript}" (長度: ${transcript.length})`);
    
    if (!transcript || transcript === '[轉錄結果為空]') {
      throw new Error('轉錄結果為空，可能是音檔無法識別或模型加載失敗');
    }

    // 步驟 5: 評估轉錄品質
    if (progressCallback) {
      progressCallback(90, "評估轉錄品質");
    }

    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;
    const quality = assessTranscriptionQuality(transcript);

    if (progressCallback) {
      progressCallback(100, "轉錄完成");
    }

    // 記錄成功信息
    logger.info(`🎯 轉錄進度: 100% - 轉錄完成`);
    logger.info(`✅ 轉錄成功完成:`);
    logger.info(`- 處理時間: ${processingTime.toFixed(2)} 秒`);
    logger.info(`- 文字長度: ${transcript.length} 字元`);
    logger.info(`- 品質評分: ${quality.score}/100`);
    logger.info(`- 信心度: ${quality.confidence.toFixed(2)}`);

    return {
      text: transcript,
      processingTime,
      quality,
      audioInfo,
    };

  } catch (error) {
    logger.error(`❌ faster-whisper 轉錄失敗: ${error.message}`);
    
    // 根據錯誤類型提供更詳細的錯誤信息
    if (error.message.includes('timeout')) {
      logger.error('轉錄超時，可能是音檔太長或系統資源不足');
    } else if (error.message.includes('ENOENT')) {
      logger.error('Python 或 faster-whisper 環境配置問題');
    } else if (error.message.includes('ModuleNotFoundError')) {
      logger.error('faster-whisper 模組未正確安裝');
    }
    
    throw error;

  } finally {
    // 清理臨時腳本文件
    if (tempScriptPath) {
      try {
        if (require('fs').existsSync(tempScriptPath)) {
          require('fs').unlinkSync(tempScriptPath);
          logger.info(`清理臨時腳本文件: ${tempScriptPath}`);
        }
      } catch (cleanupError) {
        logger.warn(`清理臨時腳本失敗: ${cleanupError.message}`);
      }
    }
    
    // 強制 Node.js 垃圾回收
    try {
      if (global.gc) {
        global.gc();
        logger.info('✅ Node.js 記憶體清理完成');
      }
    } catch (gcError) {
      logger.warn(`Node.js 垃圾回收失敗: ${gcError.message}`);
    }
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
    chineseRatio: chineseRatio,
  };
}

/**
 * 檢查重複內容
 */
function checkRepetition(text) {
  const words = text.split(/\s+/);
  const wordCount = {};

  words.forEach((word) => {
    wordCount[word] = (wordCount[word] || 0) + 1;
  });

  const repeatedWords = Object.values(wordCount).filter((count) => count > 3);
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
  const totalChars = text.replace(/\s/g, "").length;

  return totalChars > 0 ? chineseChars.length / totalChars : 0;
}

/**
 * 主要轉錄函數
 */
async function transcribeAudio(inputPath) {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });
  const processedPath = path.join(tempDir.name, "processed.mp3");

  try {
    logger.info(`🚀 開始轉錄流程: ${inputPath}`);
    logger.info(`📊 整體進度: 0% - 初始化轉錄流程`);

    // 1. 獲取音檔資訊
    logger.info(`📊 整體進度: 5% - 正在分析音檔資訊...`);
    const audioInfo = await getAudioInfo(inputPath);
    const isFromiPhone = audioInfo.isFromiPhone;

    logger.info(`🎵 音檔資訊:`);
    logger.info(`- 格式: ${audioInfo.format} (${audioInfo.codec})`);
    logger.info(`- 時長: ${(audioInfo.duration / 60).toFixed(1)} 分鐘`);
    logger.info(`- 大小: ${audioInfo.sizeMB.toFixed(2)} MB`);
    logger.info(`- iPhone 錄音: ${isFromiPhone ? "是" : "否"}`);

    // 2. 預處理音檔
    logger.info(`📊 整體進度: 15% - 正在預處理音檔...`);
    await preprocessiPhoneAudio(inputPath, processedPath, audioInfo);

    // 3. 智能分割
    logger.info(`📊 整體進度: 25% - 正在智能分割音檔...`);
    const processedInfo = await getAudioInfo(processedPath);
    const chunkFiles = await smartSplitAudioForiPhone(
      processedPath,
      processedInfo,
    );

    logger.info(`🔄 分割結果: ${chunkFiles.length} 個片段`);

    // 4. 轉錄處理
    logger.info(`📊 整體進度: 30% - 開始轉錄處理...`);
    let finalTranscript = "";
    let totalQuality = { score: 0, confidence: 0 };

    if (chunkFiles.length === 1) {
      // 單個檔案直接轉錄
      logger.info(`📊 整體進度: 35% - 單檔轉錄模式`);

      const progressCallback = (percent, message) => {
        const overallProgress = 35 + percent * 0.55; // 35% 到 90%
        logger.info(`📊 整體進度: ${overallProgress.toFixed(0)}% - ${message}`);
      };

      const result = await transcribeWithFasterWhisper(
        chunkFiles[0],
        isFromiPhone,
        progressCallback,
      );
      finalTranscript = result.text;
      totalQuality = result.quality;
    } else {
      // 多個片段批次處理
      logger.info(
        `📊 整體進度: 35% - 多檔批次轉錄模式 (${chunkFiles.length} 個片段)`,
      );

      const results = await processAudioChunks(
        chunkFiles,
        isFromiPhone,
        (current, total) => {
          const chunkProgress = 35 + (current / total) * 55; // 35% 到 90%
          logger.info(
            `📊 整體進度: ${chunkProgress.toFixed(0)}% - 正在處理片段 ${current}/${total}`,
          );
        },
      );

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
      processedFilePath: processedPath, // 提供預處理後的檔案路徑給 OpenAI API 使用
    };
  } catch (error) {
    logger.error(`❌ 轉錄流程失敗: ${error.message}`);
    throw error;
  } finally {
    // 注意：為了讓 OpenAI API 能使用預處理檔案，暫時不清理臨時目錄
    // 清理會由系統自動處理或在 OpenAI API 完成後手動清理
    logger.info(`⚠️ 保留臨時目錄供 OpenAI API 使用: ${tempDir.name}`);
  }
}

/**
 * 處理音檔分塊
 */
async function processAudioChunks(
  chunkFiles,
  isFromiPhone,
  progressCallback = null,
) {
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
        const chunkPercent =
          (i / chunkFiles.length) * 100 + percent / chunkFiles.length;
        logger.info(`📊 片段 ${i + 1} 進度: ${percent}% - ${message}`);
      };

      const result = await transcribeWithFasterWhisper(
        chunkPath,
        isFromiPhone,
        chunkProgressCallback,
      );

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
  const avgConfidence =
    results.length > 0 ? totalConfidence / results.length : 0;

  logger.info(`🎉 所有片段處理完成: ${results.length} 個片段`);

  return {
    text: results.join("\n\n"),
    quality: {
      score: avgScore,
      confidence: avgConfidence,
    },
  };
}

/**
 * 清理轉錄文字
 */
function cleanupTranscript(transcript) {
  return transcript
    .replace(/[^\u0000-\uFFFF]/g, '') // 移除超出基本多文種平面的符號
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // 移除控制字元
    .replace(/�/g, '') // 移除亂碼符號
    .replace(/([\u4e00-\u9fff])(?:[a-zA-Z]+)([\u4e00-\u9fff])/g, '$1$2') // 移除夾在中文間的英文字母
    .replace(/\[\s*\]/g, "") // 移除空白標記
    .replace(/\s+/g, " ") // 合併多個空白
    .replace(/\n\s*\n\s*\n/g, "\n\n") // 合併多個換行
    .replace(/([。！？])\s*([。！？])/g, "$1$2") // 合併重複標點
    .trim();
}

module.exports = {
  transcribeAudio,
  getAudioInfo,
  preprocessiPhoneAudio,
  assessTranscriptionQuality,
};
