/**
 * Google Sheets 服務模組 (優化版)
 * 處理所有與 Google Sheets 相關的操作
 */

/**
 * 取得試算表物件
 */
function getSpreadsheet() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/**
 * 取得工作表物件
 */
function getWorksheet() {
  const spreadsheet = getSpreadsheet();
  return spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
}

/**
 * (優化版) 檢查是否有需要處理的新資料
 * 條件：Transcription_Status = "Completed", AI_Analysis_Output 為空, 且重試次數 < MAX_RETRIES
 */
function getPendingAnalysisRows() {
  const sheet = getWorksheet();
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  if (CONFIG.DEBUG_MODE) {
    console.log(`檢查資料範圍: ${dataRange.getA1Notation()}, 總行數: ${values.length}`);
  }
  
  const pendingRows = [];
  const retryCountColIndex = getColumnIndex(CONFIG.COLUMNS.RETRY_COUNT);

  // 從第2行開始檢查 (跳過標題行)
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const transcriptionStatus = row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
    const aiAnalysisOutput = row[getColumnIndex(CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT)];
    const dataStatus = row[getColumnIndex(CONFIG.COLUMNS.DATA_STATUS)];
    const retryCount = parseInt(row[retryCountColIndex]) || 0;

    // 檢查條件：轉錄完成 + AI分析為空 + 不是正在處理中 + 重試次數未達上限
    if (transcriptionStatus === 'Completed' &&
        (!aiAnalysisOutput || aiAnalysisOutput.trim() === '') &&
        dataStatus !== 'AI Analysis In Progress' &&
        retryCount < ERROR_CONFIG.MAX_RETRIES) {
      
      pendingRows.push({
        rowIndex: i + 1, // Google Sheets 的行號從1開始
        caseId: row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)],
        transcriptText: row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPT_TEXT)],
        salespersonEmail: row[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL)],
        salespersonSlackId: row[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_SLACK_ID)],
        audioFileName: row[getColumnIndex(CONFIG.COLUMNS.AUDIO_FILE_NAME)]
      });
    }
  }
  
  if (CONFIG.DEBUG_MODE) {
    console.log(`找到 ${pendingRows.length} 筆待處理資料`);
  }
  
  return pendingRows;
}

/**
 * (優化版) 批次更新 AI 分析結果
 * 改為逐格更新，以應對欄位不連續的情況
 */
function batchUpdateAnalysisResults(analysisData) {
  if (!analysisData || analysisData.length === 0) {
    return;
  }

  const sheet = getWorksheet();
  console.log(`[INFO] 準備批次更新 ${analysisData.length} 筆分析結果...`);

  analysisData.forEach(data => {
    const rowIndex = data.rowIndex;
    try {
      sheet.getRange(`${CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT}${rowIndex}`).setValue(data.analysisOutput);
      sheet.getRange(`${CONFIG.COLUMNS.AI_PROMPT_VERSION}${rowIndex}`).setValue(CONFIG.PROMPT_VERSION);
      sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue('AI Analysis Completed');
      sheet.getRange(`${CONFIG.COLUMNS.NOTIFICATION_SENT}${rowIndex}`).setValue(data.notificationTimestamp);
      sheet.getRange(`${CONFIG.COLUMNS.FEEDBACK_FORM_URL}${rowIndex}`).setValue(data.feedbackFormUrl);
    } catch (e) {
      console.error(`[ERROR] 更新第 ${rowIndex} 行時失敗: ${e.message}`);
    }
  });

  // 因為是逐格更新，可以加入一個 flush 來確保所有變更被寫入
  SpreadsheetApp.flush();

  if (CONFIG.DEBUG_MODE) {
    console.log(`[SUCCESS] 批次更新完成，共處理了 ${analysisData.length} 筆資料。`);
  }
}

/**
 * (新功能) 增加指定任務的重試次數
 */
function incrementRetryCount(rowIndex) {
  try {
    const sheet = getWorksheet();
    const retryCell = sheet.getRange(`${CONFIG.COLUMNS.RETRY_COUNT}${rowIndex}`);
    const currentRetries = parseInt(retryCell.getValue()) || 0;
    retryCell.setValue(currentRetries + 1);
    
    if (CONFIG.DEBUG_MODE) {
      console.log(`🔄 案例 (第${rowIndex}行) 重試次數增加為 ${currentRetries + 1}`);
    }
  } catch (error) {
    console.error(`❌ 無法增加重試次數 (第${rowIndex}行):`, error);
  }
}


/**
 * 標記資料為處理中狀態
 */
function markAsProcessing(rowIndex, caseId) {
  const sheet = getWorksheet();
  const dataStatusCol = CONFIG.COLUMNS.DATA_STATUS;
  
  sheet.getRange(`${dataStatusCol}${rowIndex}`).setValue('AI Analysis In Progress');
  
  if (CONFIG.DEBUG_MODE) {
    console.log(`標記 Case ${caseId} (第${rowIndex}行) 為處理中`);
  }
}

/**
 * 處理錯誤狀態
 */
function markAsError(rowIndex, caseId, errorMessage) {
  const sheet = getWorksheet();
  const timestamp = new Date().toISOString();
  const errorStatus = `Error: ${errorMessage.substring(0, 400)} (${timestamp})`;
  
  sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue(errorStatus);
  incrementRetryCount(rowIndex); // 標記錯誤時，增加重試次數

  if (CONFIG.DEBUG_MODE) {
    console.log(`標記 Case ${caseId} (第${rowIndex}行) 為錯誤狀態: ${errorMessage}`);
  }
}

/**
 * 取得業務員的 Slack ID
 */
function getSalespersonSlackId(salespersonEmail) {
  // 從 Google Sheet 的使用者對應表查找
  const mapping = getUserMappingFromSheet();
  const slackId = mapping[salespersonEmail.toLowerCase()];
  
  if (slackId) {
    return slackId;
  }
  
  if (CONFIG.DEBUG_MODE) {
    console.log(`找不到 ${salespersonEmail} 的 Slack ID 對應`);
  }
  
  return null;
}

/**
 * 輔助函數：將欄位字母轉換為陣列索引
 */
function getColumnIndex(columnLetter) {
  return columnLetter.charCodeAt(0) - 'A'.charCodeAt(0);
}

/**
 * 輔助函數：取得指定行的完整資料
 */
function getRowData(rowIndex) {
  const sheet = getWorksheet();
  const row = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  return {
    caseId: row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)],
    salespersonEmail: row[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL)],
    transcriptText: row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPT_TEXT)],
    aiAnalysisOutput: row[getColumnIndex(CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT)],
    audioFileName: row[getColumnIndex(CONFIG.COLUMNS.AUDIO_FILE_NAME)]
  };
}
