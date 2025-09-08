const { google } = require('googleapis');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// Google Sheets API 設定
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

let sheetsClient = null;

/**
 * 初始化 Google Sheets 客戶端
 */
function initializeSheetsClient() {
  if (sheetsClient) return sheetsClient;
  
  try {
    if (!SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY 環境變數未設置');
    }
    
    if (!SPREADSHEET_ID) {
      throw new Error('GOOGLE_SPREADSHEET_ID 環境變數未設置');
    }
    
    let credentials;
    try {
      credentials = JSON.parse(SERVICE_ACCOUNT_KEY);
      
      // 修復 private key 格式問題
      if (credentials.private_key) {
        credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
      }
      
      logger.info('Google 服務帳戶憑證解析成功');
    } catch (parseError) {
      logger.error(`解析 Google 服務帳戶 JSON 失敗: ${parseError.message}`);
      throw new Error(`無效的 Google 服務帳戶 JSON 格式: ${parseError.message}`);
    }
    
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: SCOPES
    });
    
    sheetsClient = google.sheets({ version: 'v4', auth });
    logger.info('Google Sheets 客戶端初始化完成');
    
    return sheetsClient;
  } catch (error) {
    logger.error(`Google Sheets 客戶端初始化失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 更新 Google Sheets 中的轉錄結果
 */
async function updateGoogleSheet(caseId, transcript, status = 'Completed', metadata = {}) {
  try {
    logger.info(`開始更新 Google Sheets - Case ID: ${caseId}`);
    
    const sheets = initializeSheetsClient();
    
    // 尋找對應的行
    const rowIndex = await findRowByCaseId(caseId);
    
    if (rowIndex === -1) {
      logger.error(`找不到 Case ID: ${caseId} 的記錄`);
      throw new Error(`找不到 Case ID: ${caseId} 的記錄`);
    }
    
    // 只更新 F 欄 (狀態) 和 G 欄 (轉錄文字)，不覆蓋 A-E 欄的 n8n 數據
    const batchUpdates = [
      {
        range: `F${rowIndex + 1}`, // F 欄：狀態
        values: [[status]]
      },
      {
        range: `G${rowIndex + 1}`, // G 欄：轉錄文字
        values: [[transcript]]
      }
    ];
    
    // 批次更新，確保不覆蓋其他欄位
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: batchUpdates
      }
    });
    
    logger.info(`Google Sheets 更新完成 - Case ID: ${caseId}, 狀態: ${status}, 轉錄長度: ${transcript.length} 字元`);
    
    return {
      success: true,
      caseId,
      rowIndex: rowIndex + 1,
      updateTime: new Date().toISOString()
    };
    
  } catch (error) {
    logger.error(`更新 Google Sheets 失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 根據 Case ID 尋找對應的行
 */
async function findRowByCaseId(caseId) {
  try {
    const sheets = initializeSheetsClient();
    
    // 讀取整個工作表的第一欄（假設 Case ID 在第一欄）
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:A'
    });
    
    const values = response.data.values || [];
    
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === caseId) {
        return i; // 回傳索引（0-based）
      }
    }
    
    return -1; // 找不到
    
  } catch (error) {
    logger.error(`搜尋 Case ID 失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 取得指定 Case ID 的記錄
 */
async function getCaseRecord(caseId) {
  try {
    const sheets = initializeSheetsClient();
    const rowIndex = await findRowByCaseId(caseId);
    
    if (rowIndex === -1) {
      return null;
    }
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `A${rowIndex + 1}:Z${rowIndex + 1}`
    });
    
    const values = response.data.values || [];
    
    if (values.length === 0) {
      return null;
    }
    
    return {
      rowIndex: rowIndex + 1,
      values: values[0],
      caseId: values[0][0] || caseId
    };
    
  } catch (error) {
    logger.error(`取得 Case 記錄失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 批次更新多個記錄
 */
async function batchUpdateRecords(updates) {
  try {
    const sheets = initializeSheetsClient();
    
    const batchUpdateData = [];
    
    for (const update of updates) {
      const { caseId, transcript, status, metadata } = update;
      const rowIndex = await findRowByCaseId(caseId);
      
      if (rowIndex !== -1) {
        const currentTime = new Date().toISOString();
        const updateData = [
          transcript,
          status,
          currentTime,
          metadata?.processingMethod || '',
          metadata?.qualityScore || '',
          metadata?.confidence || ''
        ];
        
        batchUpdateData.push({
          range: `A${rowIndex + 1}:F${rowIndex + 1}`,
          values: [updateData]
        });
      }
    }
    
    if (batchUpdateData.length === 0) {
      logger.warn('沒有找到任何要更新的記錄');
      return { success: true, updatedCount: 0 };
    }
    
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: batchUpdateData
      }
    });
    
    logger.info(`批次更新完成: ${batchUpdateData.length} 筆記錄`);
    
    return {
      success: true,
      updatedCount: batchUpdateData.length
    };
    
  } catch (error) {
    logger.error(`批次更新失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 新增記錄到 Google Sheets
 */
async function addNewRecord(caseId, fileId, fileName, status = 'Processing') {
  try {
    const sheets = initializeSheetsClient();
    
    const currentTime = new Date().toISOString();
    const newRecord = [
      caseId,
      fileId,
      fileName,
      status,
      currentTime, // 創建時間
      '', // 轉錄結果（待填入）
      '', // 處理方法
      '', // 品質分數
      ''  // 信心度
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:I',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [newRecord]
      }
    });
    
    logger.info(`新增記錄完成 - Case ID: ${caseId}`);
    
    return {
      success: true,
      caseId,
      createTime: currentTime
    };
    
  } catch (error) {
    logger.error(`新增記錄失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 取得工作表統計資訊
 */
async function getSheetStats() {
  try {
    const sheets = initializeSheetsClient();
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:I'
    });
    
    const values = response.data.values || [];
    
    if (values.length === 0) {
      return {
        totalRecords: 0,
        statusCounts: {},
        lastUpdate: null
      };
    }
    
    const records = values.slice(1); // 跳過標題行
    const statusCounts = {};
    let lastUpdate = null;
    
    records.forEach(record => {
      const status = record[3] || 'Unknown';
      const updateTime = record[4] || record[5]; // 創建時間或更新時間
      
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      
      if (updateTime && (!lastUpdate || new Date(updateTime) > new Date(lastUpdate))) {
        lastUpdate = updateTime;
      }
    });
    
    return {
      totalRecords: records.length,
      statusCounts,
      lastUpdate
    };
    
  } catch (error) {
    logger.error(`取得工作表統計失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 檢查工作表連接狀態
 */
async function checkConnection() {
  try {
    const sheets = initializeSheetsClient();
    
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'properties.title'
    });
    
    return {
      connected: true,
      spreadsheetTitle: response.data.properties.title
    };
    
  } catch (error) {
    logger.error(`檢查工作表連接失敗: ${error.message}`);
    return {
      connected: false,
      error: error.message
    };
  }
}

module.exports = {
  updateGoogleSheet,
  findRowByCaseId,
  getCaseRecord,
  batchUpdateRecords,
  addNewRecord,
  getSheetStats,
  checkConnection
};