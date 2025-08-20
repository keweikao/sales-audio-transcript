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

/**
 * Calls the Python script to transcribe audio using faster-whisper.
 * @param {string} audioPath The path to the audio file.
 * @returns {Promise<string>} A promise that resolves with the transcribed text.
 */
function transcribeWithFasterWhisper(audioPath) {
  return new Promise((resolve, reject) => {
    const pythonScriptPath = path.join(__dirname, 'transcribe.py');
    const pythonProcess = spawn('python3', [pythonScriptPath, audioPath], {
      timeout: 29 * 60 * 1000 // 29 minutes timeout for the Python process
    });

    // Handle process timeout
    pythonProcess.on('timeout', () => {
      logger.error('Python script timed out.');
      pythonProcess.kill(); // Terminate the process
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
      if (code === 0) {
        logger.info('Python script finished successfully.');
        resolve(transcript.trim());
      } else {
        logger.error(`Python script exited with code ${code}`);
        reject(new Error(`Transcription failed with exit code ${code}. Error: ${errorMessage}`));
      }
    });

    // Handle process errors
    pythonProcess.on('error', (err) => {
      logger.error('Failed to start Python script.', err);
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
      .audioBitrate('96k')
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

    // 2. Pre-process audio
    const processedPath = path.join(tempDir.name, 'processed.mp3');
    await preprocessiPhoneAudio(inputPath, processedPath, audioInfo);

    // 3. Transcribe using faster-whisper python script
    const transcript = await transcribeWithFasterWhisper(processedPath);
    logger.info(`Transcription received from Python script. Length: ${transcript.length}`);

    // 4. Assess quality
    const quality = assessTranscriptionQuality(transcript);
    logger.info(`Transcription quality assessed: Score ${quality.score}, Confidence ${quality.confidence}`);

    return {
      transcript: transcript,
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
