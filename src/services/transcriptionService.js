const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const tmp = require('tmp');
const winston = require('winston');
const { spawn } = require('child_process');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// Configuration for iPhone recordings and chunking (adapted from remote)
const IPHONE_OPTIMIZED_CONFIG = {
  // Using 'base' model for OpenAI whisper (can be changed to 'large-v3' if resources allow)
  modelName: 'base',
  // Chunking strategy for iPhone recordings - 增加到 30 分鐘避免過多分塊
  chunkDuration: 30 * 60, // 30 minutes per chunk, to avoid too many parallel processes
  // Audio preprocessing parameters (already in preprocessiPhoneAudio)
  preprocessing: {
    bitrate: 64,
    sampleRate: 16000,
    channels: 1,
    filters: [
      'highpass=f=80',
      'lowpass=f=8000'
    ]
  },
  // OpenAI whisper specific options
  whisperOptions: {
    language: 'zh'
  }
};

/**
 * Calls the Python script to transcribe audio using OpenAI whisper.
 * @param {string} audioPath The path to the audio file.
 * @returns {Promise<string>} A promise that resolves with the transcribed text.
 */
// 全域變數追蹤當前進程，確保同時只有一個 Whisper 進程運行
let currentWhisperProcess = null;

function transcribeWithOpenAIWhisper(audioPath) {
  return new Promise((resolve, reject) => {
    // 🚫 如果已經有進程在運行，等待它完成
    if (currentWhisperProcess) {
      logger.warn(`⚠️ 偵測到已有 Whisper 進程運行，等待完成...`);
      return reject(new Error('Another Whisper process is already running. Sequential processing violated.'));
    }
    
    const pythonScriptPath = path.join(__dirname, 'whisper_transcribe.py');
    logger.info(`🚀 啟動 Python Whisper 進程: ${path.basename(audioPath)}`);
    
    const pythonProcess = spawn('python3', [pythonScriptPath, audioPath, '--output-json'], {
      timeout: 29 * 60 * 1000 // 29 minutes timeout for the Python process
    });
    
    // 設定當前進程
    currentWhisperProcess = pythonProcess;

    // Handle process timeout
    pythonProcess.on('timeout', () => {
      logger.error('⏰ Python script timed out.');
      pythonProcess.kill(); // Terminate the process
      // 清理當前進程追蹤
      currentWhisperProcess = null;
      logger.info(`🔄 Python 進程超時，已清理進程追蹤`);
      reject(new Error('Transcription process exceeded its time limit (29 minutes).'));
    });

    let transcript = '';
    let errorMessage = '';

    // Capture standard output from the Python script
    pythonProcess.stdout.on('data', (data) => {
      transcript += data.toString();
    });

    // Capture standard error
    pythonProcess.stderr.on('data', (data) => {
      const stderrLine = data.toString();
      logger.error(`[Python Script]: ${stderrLine}`);
      errorMessage += stderrLine;
    });

    // Handle process exit
    pythonProcess.on('close', (code) => {
      // 清理當前進程追蹤
      currentWhisperProcess = null;
      logger.info(`🔄 Python Whisper 進程結束，已清理進程追蹤`);
      
      if (code === 0) {
        logger.info('✅ Python script finished successfully.');
        try {
          // Try to parse as JSON first, fallback to plain text
          const result = JSON.parse(transcript.trim());
          resolve(result);
        } catch (parseError) {
          // If not JSON, treat as plain text
          resolve(transcript.trim());
        }
      } else {
        logger.error(`❌ Python script exited with code ${code}`);
        reject(new Error(`Transcription failed with exit code ${code}. Error: ${errorMessage}`));
      }
    });

    // Handle process errors
    pythonProcess.on('error', (err) => {
      // 清理當前進程追蹤
      currentWhisperProcess = null;
      logger.error('❌ Failed to start Python script.', err);
      reject(err);
    });
  });
}

/**
 * Gets detailed information about an audio file.
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
 * Detects if the recording is from an iPhone based on metadata.
 */
function detectiPhoneRecording(metadata) {
  const format = metadata.format;
  const isiPhoneFormat = format.format_name?.includes('mov') || 
                        format.format_name?.includes('mp4') ||
                        format.format_name?.includes('m4a');
  const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
  const isiPhoneCodec = audioStream?.codec_name === 'aac';
  return isiPhoneFormat && isiPhoneCodec;
}

/**
 * Pre-processes audio files, especially for iPhone recordings.
 */
async function preprocessiPhoneAudio(inputPath, outputPath, audioInfo) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting audio preprocessing for: ${inputPath}`);
    
    const ffmpegCommand = ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioFilters('highpass=f=80', 'lowpass=f=8000')
      .output(outputPath);
    
    ffmpegCommand
      .on('start', (commandLine) => {
        logger.info(`FFmpeg command: ${commandLine}`);
      })
      .on('end', () => {
        logger.info(`Preprocessing finished: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        logger.error(`Preprocessing failed: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Extracts an audio chunk (from remote)
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
 * Splits audio by time into chunks (from remote)
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
 * Assesses the quality of the transcribed text.
 */
function assessTranscriptionQuality(transcript) {
  if (!transcript || transcript.length === 0) {
    return { score: 0, confidence: 0.0, details: 'Empty transcript' };
  }

  let score = 100;
  let confidence = 1.0;
  
  if (transcript.length < 10) {
    score -= 50;
    confidence -= 0.5;
  }
  
  const chineseRatio = (transcript.match(/[\u4e00-\u9fff]/g) || []).length / transcript.length;
  if (chineseRatio < 0.5) {
    score -= 20;
    confidence -= 0.2;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    confidence: Math.max(0, Math.min(1, confidence)),
    chineseRatio
  };
}

/**
 * Main transcription function that orchestrates the process.
 */
async function transcribeAudio(inputPath) {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });
  try {
    logger.info(`Starting transcription process for: ${inputPath}`);
    
    // 1. Get audio info
    const audioInfo = await getAudioInfo(inputPath);
    logger.info(`Audio info retrieved: ${audioInfo.duration}s, ${audioInfo.sizeMB.toFixed(2)}MB`);

    let fullTranscript = '';

    // Check if chunking is needed for very long audio
    if (audioInfo.duration > IPHONE_OPTIMIZED_CONFIG.chunkDuration) {
      logger.info(`Audio duration (${audioInfo.duration}s) exceeds chunk duration (${IPHONE_OPTIMIZED_CONFIG.chunkDuration}s). Splitting into chunks.`);
      const chunks = await splitByTime(inputPath, IPHONE_OPTIMIZED_CONFIG.chunkDuration);

      // 🔄 嚴格序列處理每個 chunk，一次只處理一個，避免資源過載
      logger.info(`📊 開始序列處理 ${chunks.length} 個音檔片段`);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = chunks[i];
        logger.info(`🎵 開始處理片段 ${i + 1}/${chunks.length}: ${path.basename(chunkPath)}`);
        logger.info(`📂 片段路徑: ${chunkPath}`);
        
        // 步驟 1: 預處理音檔
        const processedPath = path.join(tempDir.name, `processed_chunk_${i}.mp3`);
        logger.info(`🔧 預處理片段 ${i + 1}...`);
        await preprocessiPhoneAudio(chunkPath, processedPath, audioInfo);
        
        // 步驟 2: 轉錄處理（確保一個完成後才開始下一個）
        logger.info(`🤖 轉錄片段 ${i + 1}，等待 Whisper 處理完成...`);
        const startTime = Date.now();
        
        const result = await transcribeWithOpenAIWhisper(processedPath);
        
        const endTime = Date.now();
        const processingTime = Math.round((endTime - startTime) / 1000);
        
        const chunkTranscript = typeof result === 'string' ? result : result.text;
        fullTranscript += chunkTranscript + ' ';
        
        logger.info(`✅ 片段 ${i + 1} 轉錄完成 - 耗時: ${processingTime}秒, 文字長度: ${chunkTranscript.length}`);
        
        // 清理當前片段的臨時檔案，釋放空間
        try {
          if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
          if (fs.existsSync(processedPath)) fs.unlinkSync(processedPath);
          logger.info(`🗑️ 已清理片段 ${i + 1} 的臨時檔案`);
        } catch (cleanupErr) {
          logger.warn(`⚠️ 清理片段 ${i + 1} 臨時檔案失敗: ${cleanupErr.message}`);
        }
        
        // 在片段之間加入短暫延遲，確保資源完全釋放
        if (i < chunks.length - 1) {
          logger.info(`⏸️ 片段 ${i + 1} 處理完成，等待 2 秒後處理下一片段...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      logger.info(`🎉 所有 ${chunks.length} 個片段序列處理完成，總文字長度: ${fullTranscript.length}`);
    }
    } else {
      // 2. Pre-process audio (single file)
      const processedPath = path.join(tempDir.name, 'processed.mp3');
      await preprocessiPhoneAudio(inputPath, processedPath, audioInfo);

      // 3. Transcribe using OpenAI whisper python script (single file)
      const result = await transcribeWithOpenAIWhisper(processedPath);
      fullTranscript = typeof result === 'string' ? result : result.text;
      logger.info(`Transcription received from Python script. Length: ${fullTranscript.length}`);
    }

    // 4. Assess quality
    const quality = assessTranscriptionQuality(fullTranscript);
    logger.info(`Transcription quality assessed: Score ${quality.score}, Confidence ${quality.confidence}`);

    return {
      transcript: fullTranscript,
      quality: quality,
      audioInfo: audioInfo
    };

  } catch (error) {
    logger.error(`Full transcription process failed: ${error.message}`);
    throw error;
  } finally {
    // Clean up the temporary directory
    try {
      if (fs.existsSync(tempDir.name)) {
        fs.rmSync(tempDir.name, { recursive: true, force: true });
        logger.info(`Temporary directory cleaned up: ${tempDir.name}`);
      }
    } catch (cleanupError) {
      logger.warn(`Failed to clean up temporary directory: ${cleanupError.message}`);
    }
  }
}

module.exports = {
  transcribeAudio,
  getAudioInfo,
  preprocessiPhoneAudio,
  assessTranscriptionQuality
};