const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
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

// Google Drive API 設定
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

let driveClient = null;

/**
 * 初始化 Google Drive 客戶端
 */
function initializeDriveClient() {
  if (driveClient) return driveClient;
  
  try {
    if (!SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY 環境變數未設置');
    }
    
    const credentials = JSON.parse(SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: SCOPES
    });
    
    driveClient = google.drive({ version: 'v3', auth });
    logger.info('Google Drive 客戶端初始化完成');
    
    return driveClient;
  } catch (error) {
    logger.error(`Google Drive 客戶端初始化失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 從 Google Drive 下載檔案
 */
async function downloadFromGoogleDrive(fileId, fileName = 'audio_file') {
  try {
    logger.info(`開始下載 Google Drive 檔案: ${fileId}`);
    
    const drive = initializeDriveClient();
    
    // 獲取檔案資訊
    const fileMetadata = await drive.files.get({
      fileId: fileId,
      fields: 'name, mimeType, size'
    });
    
    const originalName = fileMetadata.data.name || fileName;
    const fileSize = parseInt(fileMetadata.data.size) / (1024 * 1024); // MB
    
    logger.info(`檔案資訊: ${originalName}, 大小: ${fileSize.toFixed(2)} MB`);
    
    // 創建本地臨時檔案路徑
    const tempDir = tmp.dirSync({ unsafeCleanup: true });
    const localFilePath = path.join(tempDir.name, sanitizeFileName(originalName));
    
    // 下載檔案
    const response = await drive.files.get({
      fileId: fileId,
      alt: 'media'
    }, { responseType: 'stream' });
    
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(localFilePath);
      let downloadedSize = 0;
      
      response.data.on('error', (error) => {
        logger.error(`檔案下載失敗: ${error.message}`);
        reject(error);
      });
      
      response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const progress = (downloadedSize / (fileSize * 1024 * 1024)) * 100;
        if (progress % 20 < 5) { // 每20%報告一次進度
          logger.info(`下載進度: ${progress.toFixed(1)}%`);
        }
      });
      
      response.data.on('end', () => {
        logger.info(`檔案下載完成: ${localFilePath}`);
        resolve(localFilePath);
      });
      
      response.data.pipe(writeStream);
    });
    
  } catch (error) {
    logger.error(`從 Google Drive 下載檔案失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 取得檔案詳細資訊
 */
async function getFileInfo(fileId) {
  try {
    const drive = initializeDriveClient();
    
    const response = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, createdTime, modifiedTime, parents'
    });
    
    const fileInfo = response.data;
    
    return {
      id: fileInfo.id,
      name: fileInfo.name,
      mimeType: fileInfo.mimeType,
      sizeMB: fileInfo.size ? (parseInt(fileInfo.size) / (1024 * 1024)).toFixed(2) : 'Unknown',
      createdTime: fileInfo.createdTime,
      modifiedTime: fileInfo.modifiedTime,
      parents: fileInfo.parents
    };
    
  } catch (error) {
    logger.error(`取得檔案資訊失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 檢查檔案是否存在且可存取
 */
async function checkFileAccess(fileId) {
  try {
    const drive = initializeDriveClient();
    
    await drive.files.get({
      fileId: fileId,
      fields: 'id, name'
    });
    
    return true;
  } catch (error) {
    if (error.code === 404) {
      logger.warn(`檔案不存在: ${fileId}`);
      return false;
    } else if (error.code === 403) {
      logger.warn(`沒有檔案存取權限: ${fileId}`);
      return false;
    } else {
      logger.error(`檢查檔案存取權限失敗: ${error.message}`);
      throw error;
    }
  }
}

/**
 * 清理檔案名稱，移除不安全字符
 */
function sanitizeFileName(fileName) {
  // 移除或替換不安全的字符
  return fileName
    .replace(/[<>:"/\\|?*]/g, '_') // 替換不安全字符
    .replace(/\s+/g, '_') // 替換空白
    .replace(/_{2,}/g, '_') // 合併多個底線
    .substring(0, 100); // 限制檔名長度
}

/**
 * 批次下載多個檔案
 */
async function downloadMultipleFiles(fileIds) {
  const downloadPromises = fileIds.map(async (fileId) => {
    try {
      const filePath = await downloadFromGoogleDrive(fileId);
      return { fileId, filePath, success: true };
    } catch (error) {
      logger.error(`下載檔案 ${fileId} 失敗: ${error.message}`);
      return { fileId, error: error.message, success: false };
    }
  });
  
  const results = await Promise.all(downloadPromises);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  logger.info(`批次下載完成: ${successful.length} 成功, ${failed.length} 失敗`);
  
  return {
    successful,
    failed,
    totalCount: fileIds.length
  };
}

/**
 * 清理本地臨時檔案
 */
function cleanupLocalFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`清理本地檔案: ${filePath}`);
    }
  } catch (error) {
    logger.warn(`清理本地檔案失敗: ${error.message}`);
  }
}

module.exports = {
  downloadFromGoogleDrive,
  getFileInfo,
  checkFileAccess,
  downloadMultipleFiles,
  cleanupLocalFile
};