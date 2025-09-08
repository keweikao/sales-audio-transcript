/**
 * Google Apps Script - 銷售 AI 分析自動化系統 (優化版)
 * 主要程式邏輯和觸發器
 */

// =====================================================================================
// 主要處理流程 (AI 分析)
// =====================================================================================

/**
 * (優化版) 主要處理函數 - 批次處理所有待分析的資料
 * 這個函數會被定時觸發器呼叫
 */
function processAllPendingAnalysis() {
  console.log('🚀 開始執行銷售 AI 分析流程 (批次模式)...');
  
  try {
    if (isSystemPaused()) {
      console.log('⏸️ 系統已暫停，跳過 AI 分析處理');
      return;
    }

    if (!validateConfiguration()) {
      console.error('❌ 設定檢查失敗，停止執行');
      return;
    }
    
    const pendingRows = getPendingAnalysisRows();
    
    if (pendingRows.length === 0) {
      console.log('✨ 沒有待分析的資料');
      return;
    }
    
    console.log(`📋 找到 ${pendingRows.length} 筆待分析資料，開始批次處理...`);
    
    const analysisDataForBatchUpdate = [];
    let successCount = 0;
    let errorCount = 0;

    // 步驟 1: 在記憶體中逐一處理，準備批次更新資料
    for (const row of pendingRows) {
      try {
        console.log(`\n🔄 正在分析案例: ${row.caseId} (第 ${row.rowIndex} 行)`);
        markAsProcessing(row.rowIndex, row.caseId); // 先標記為處理中

        if (!row.transcriptText || row.transcriptText.trim().length < 50) {
          throw new Error('轉錄文字太短或為空，無法進行分析');
        }

        // 呼叫 Gemini AI 進行分析
        console.log(`🤖 呼叫 Gemini AI 分析...`);
        const analysisOutput = analyzeTranscriptWithGemini(row.transcriptText);
        if (!analysisOutput || analysisOutput.trim() === '') {
          throw new Error('AI 分析結果為空');
        }

        // 準備 Slack 通知和回饋表單
        const feedbackFormUrl = `${CONFIG.FEEDBACK_FORM_TEMPLATE}${encodeURIComponent(row.caseId)}`;
        console.log(`💬 準備發送 Slack 通知...`);
        const notificationSent = sendSlackNotification(row.caseId, analysisOutput, row.salespersonEmail, feedbackFormUrl);
        const notificationTimestamp = notificationSent ? new Date().toISOString() : '';
        if (!notificationSent) {
           console.warn(`⚠️ 案例 ${row.caseId} 的 Slack 通知發送失敗`);
        }

        // 將結果存入待更新陣列
        analysisDataForBatchUpdate.push({
          rowIndex: row.rowIndex,
          analysisOutput: analysisOutput,
          notificationTimestamp: notificationTimestamp,
          feedbackFormUrl: feedbackFormUrl
        });

        successCount++;
        console.log(`✅ 案例 ${row.caseId} 分析完成`);

      } catch (error) {
        errorCount++;
        console.error(`❌ 處理案例 ${row.caseId} 時發生錯誤:`, error);
        markAsError(row.rowIndex, row.caseId, error.message); // 標記錯誤並增加重試次數
        sendErrorNotification(error.message, row.caseId);
      }
       // 避免 API 限制，每次處理後稍微等待
      Utilities.sleep(1500);
    }

    // 步驟 2: 一次性將所有成功處理的結果寫回 Google Sheet
    if (analysisDataForBatchUpdate.length > 0) {
      console.log(`\n📝 準備將 ${analysisDataForBatchUpdate.length} 筆成功的分析結果一次性寫回 Google Sheet...`);
      batchUpdateAnalysisResults(analysisDataForBatchUpdate);
    }

    console.log(`\n📊 批次處理完成：成功 ${successCount} 筆，失敗 ${errorCount} 筆`);

  } catch (error) {
    console.error('❌ 主流程執行失敗:', error);
    sendErrorNotification(`主流程執行失敗: ${error.message}`);
  }
}


// =====================================================================================
// 資料同步與佇列管理 (音檔轉錄)
// =====================================================================================

/**
 * (優化版) 智能資料同步 - 確保表單回應與主資料庫完全同步
 * 定時執行，比對音檔上傳表單與主資料庫，補充遺漏的完整資料
 */
function syncFormToDatabase() {
  console.log('🔄 開始表單回應與主資料庫同步...');
  
  try {
    if (isSystemPaused()) {
      console.log('⏸️ 系統已暫停，跳過同步處理');
      return;
    }

    // 1. 讀取來源與目標資料
    const audioFormSheet = SpreadsheetApp.openById(CONFIG.AUDIO_FORM_SPREADSHEET_ID);
    const formResponseSheet = audioFormSheet.getSheetByName(CONFIG.AUDIO_FORM_SHEET_NAME);
    const formData = formResponseSheet.getDataRange().getValues();
    
    const mainSheet = getWorksheet();
    const mainData = mainSheet.getDataRange().getValues();
    const mainDbCases = new Set(mainData.slice(1).map(row => row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)]));

    if (formData.length <= 1) {
      console.log('✨ 表單回應為空，無需同步');
      return;
    }

    // 2. 找出需要同步的新紀錄
    const newEntries = [];
    const syncedRowIndices = [];

    for (let i = 1; i < formData.length; i++) {
      const row = formData[i];
      const caseId = row[3];
      const audioFileLink = row[2];
      const syncStatus = row[4]; // E欄: Sync_Status

      if (caseId && audioFileLink && !mainDbCases.has(caseId) && syncStatus !== 'Synced') {
        newEntries.push({
          caseId: caseId,
          submissionTime: row[0],
          salespersonEmail: row[1],
          audioFileLink: audioFileLink,
          audioFileName: `${caseId}_audio`
        });
        syncedRowIndices.push(i + 1);
      }
    }

    if (newEntries.length === 0) {
      console.log('✅ 資料庫與表單回應已同步');
      return;
    }

    console.log(`📊 發現 ${newEntries.length} 筆新紀錄需要同步`);

    // 3. 將新紀錄批次新增到主資料庫
    const rowsToAppend = newEntries.map(entry => [
      entry.caseId,                     // A: Case_ID
      entry.submissionTime,             // B: Submission_Timestamp
      entry.salespersonEmail,           // C: Salesperson_Email
      entry.audioFileName,              // D: Audio_File_Name
      entry.audioFileLink,              // E: Audio_File_Link_GDrive
      'Pending',                        // F: Transcription_Status
      '', '', '', '', '', '', '', '',   // G-N
      'Synced from Form',               // O: Data_Status
      '',                               // P: Salesperson_Slack_ID
      '', '' ,                           // Q-R
      0                                 // S: Retry_Count
    ]);
    
    mainSheet.getRange(mainSheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
    console.log(`📝 已將 ${newEntries.length} 筆新紀錄新增到 Master_Log`);

    // 4. 更新來源表單的同步狀態
    syncedRowIndices.forEach(rowIndex => {
      formResponseSheet.getRange(`E${rowIndex}`).setValue('Synced');
    });
    console.log(`✅ 已更新 ${syncedRowIndices.length} 筆紀錄的同步狀態`);

  } catch (error) {
    console.error('❌ 表單同步失敗:', error);
    sendErrorNotification(`表單同步失敗: ${error.message}`);
  }
}

/**
 * 智能音檔佇列處理器 - 一次只處理一個，完成後再處理下一個
 */
async function smartAudioQueueProcessor() {
  console.log('🔍 開始智能音檔佇列巡邏...');
  
  try {
    if (isSystemPaused()) {
      console.log('⏸️ 系統已暫停，跳過音檔處理');
      return;
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      console.log('🔒 另一個佇列處理程序正在運行，跳過本次執行');
      return;
    }

    const sheet = getWorksheet();
    const values = sheet.getDataRange().getValues();
    const queueStats = analyzeQueueStatus(values);

    if (queueStats.inProgress > 0) {
      console.log(`⏳ 當前有 ${queueStats.inProgress} 個任務處理中，等待完成`);
      lock.releaseLock();
      return;
    }

    if (queueStats.pending > 0) {
      console.log(`🚀 從 ${queueStats.pending} 個待處理任務中選取一個`);
      const nextTask = findNextPendingTask(values);
      if (nextTask) {
        await processNextTask(nextTask);
      }
    } else {
      console.log('✨ 目前沒有待處理的音檔任務');
    }

    lock.releaseLock();

  } catch (error) {
    console.error('❌ 智能佇列處理失敗:', error);
    sendErrorNotification(`智能佇列處理失敗: ${error.message}`);
    // 確保鎖被釋放
    const lock = LockService.getScriptLock();
    lock.releaseLock();
  }
}

/**
 * 處理下一個轉錄任務
 */
async function processNextTask(task) {
  try {
    markTranscriptionStatus(task.caseId, 'In Progress');
    
    const audioFormData = { caseId: task.caseId, audioFileLink: task.audioFileLink };
    const result = await callTranscriptionAPI(audioFormData);
    
    if (!result.success) {
      throw new Error(result.message || '轉錄請求送出失敗');
    }

  } catch (error) {
    console.error(`❌ 處理任務 ${task.caseId} 失敗:`, error);
    // 使用 markAsError 來增加重試次數
    markAsError(task.rowIndex, task.caseId, `轉錄請求失敗: ${error.message}`);
    sendErrorNotification(error.message, task.caseId);
  }
}

/**
 * 呼叫 Zeabur 轉錄 API (異步模式)
 */
async function callTranscriptionAPI(audioFormData) {
  try {
    const { caseId, audioFileLink } = audioFormData;
    const fileIdMatch = audioFileLink.match(/id=([a-zA-Z0-9_-]+)/);
    if (!fileIdMatch) throw new Error('無法從音檔連結中提取 File ID');
    
    const requestData = { fileId: fileIdMatch[1], fileName: `${caseId}_audio`, caseId: caseId };
    console.log(`📤 發送轉錄請求 (異步):`, JSON.stringify(requestData, null, 2));

    const response = UrlFetchApp.fetch(CONFIG.ZEABUR_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify(requestData),
      muteHttpExceptions: true,
      timeout: 10000
    });

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode === 200) {
      console.log(`✅ 轉錄請求已成功送出: ${caseId}`);
      return { success: true, message: '轉錄請求已送出' };
    } else {
      const errorMsg = `轉錄請求失敗 (${responseCode}): ${responseText}`;
      console.error(errorMsg);
      return { success: false, message: errorMsg };
    }
  } catch (error) {
    console.error(`❌ 呼叫轉錄 API 失敗:`, error);
    return { success: false, message: error.message };
  }
}


// =====================================================================================
// Webhook 處理器 (轉錄完成回調)
// =====================================================================================

/**
 * Webhook 處理器 - 接收轉錄服務的完成回調
 * 這個函數會被外部服務（Zeabur 轉錄 API）呼叫，當轉錄完成時
 */
function doPost(e) {
  console.log('📥 收到 webhook 回調請求');
  
  try {
    // 檢查請求是否有內容
    if (!e || !e.postData || !e.postData.contents) {
      console.error('❌ Webhook 請求缺少必要資料');
      return ContentService.createTextOutput('Error: Missing request data').setMimeType(ContentService.MimeType.TEXT);
    }

    // 解析 JSON 資料
    const requestData = JSON.parse(e.postData.contents);
    console.log('📄 收到的資料:', JSON.stringify(requestData, null, 2));

    // 驗證必要欄位
    if (!requestData.caseId || !requestData.transcriptText) {
      console.error('❌ Webhook 資料缺少必要欄位 (caseId 或 transcriptText)');
      return ContentService.createTextOutput('Error: Missing required fields').setMimeType(ContentService.MimeType.TEXT);
    }

    const { caseId, transcriptText, status } = requestData;
    console.log(`🎯 處理案例: ${caseId}, 轉錄狀態: ${status}`);

    // 更新 Google Sheet 中的轉錄結果
    const updateResult = updateTranscriptionResult(caseId, transcriptText, status);
    
    if (updateResult.success) {
      console.log(`✅ 成功更新案例 ${caseId} 的轉錄結果`);
      return ContentService.createTextOutput('Success').setMimeType(ContentService.MimeType.TEXT);
    } else {
      console.error(`❌ 更新案例 ${caseId} 失敗: ${updateResult.message}`);
      return ContentService.createTextOutput(`Error: ${updateResult.message}`).setMimeType(ContentService.MimeType.TEXT);
    }

  } catch (error) {
    console.error('❌ Webhook 處理失敗:', error);
    sendErrorNotification(`Webhook 處理失敗: ${error.message}`);
    return ContentService.createTextOutput(`Error: ${error.message}`).setMimeType(ContentService.MimeType.TEXT);
  }
}

/**
 * 更新轉錄結果到 Google Sheet
 */
function updateTranscriptionResult(caseId, transcriptText, status = 'Completed') {
  try {
    const sheet = getWorksheet();
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    // 找到對應的案例
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const currentCaseId = row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)];
      
      if (currentCaseId === caseId) {
        const rowIndex = i + 1;
        console.log(`🎯 找到案例 ${caseId} (第 ${rowIndex} 行)，開始更新轉錄結果`);
        
        // 更新轉錄文字
        sheet.getRange(`${CONFIG.COLUMNS.TRANSCRIPT_TEXT}${rowIndex}`).setValue(transcriptText);
        
        // 更新轉錄狀態
        sheet.getRange(`${CONFIG.COLUMNS.TRANSCRIPTION_STATUS}${rowIndex}`).setValue(status);
        
        // 更新資料狀態，標記為準備進行 AI 分析
        sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue('Transcription Completed - Ready for AI Analysis');
        
        // 重置重試次數
        sheet.getRange(`${CONFIG.COLUMNS.RETRY_COUNT}${rowIndex}`).setValue(0);
        
        console.log(`✅ 成功更新案例 ${caseId} 的轉錄結果`);
        return { success: true, message: '轉錄結果已更新' };
      }
    }
    
    // 如果找不到對應的案例
    console.warn(`⚠️ 找不到對應的案例 ID: ${caseId}`);
    return { success: false, message: `找不到案例 ID: ${caseId}` };
    
  } catch (error) {
    console.error(`❌ 更新轉錄結果失敗:`, error);
    return { success: false, message: error.message };
  }
}

/**
 * 測試 webhook 處理功能 (開發用)
 * 模擬轉錄服務的回調，用於測試 doPost 函數
 */
function testWebhookHandler() {
  console.log('🧪 開始測試 webhook 處理功能...');
  
  // 模擬 webhook 請求資料
  const mockEvent = {
    postData: {
      contents: JSON.stringify({
        caseId: '202409-TEST001',  // 請替換為你 Sheet 中實際存在的 Case ID
        transcriptText: '這是測試用的轉錄文字內容。客戶詢問產品價格和規格，業務人員進行了詳細的介紹和報價。',
        status: 'Completed'
      })
    }
  };
  
  try {
    const result = doPost(mockEvent);
    console.log('🎯 測試結果:', result.getContent());
    
    // 額外驗證：檢查 Google Sheet 是否有更新
    const sheet = getWorksheet();
    const values = sheet.getDataRange().getValues();
    
    for (let i = 1; i < values.length; i++) {
      if (values[i][getColumnIndex(CONFIG.COLUMNS.CASE_ID)] === '202409-TEST001') {
        const transcriptText = values[i][getColumnIndex(CONFIG.COLUMNS.TRANSCRIPT_TEXT)];
        const status = values[i][getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
        
        console.log(`✅ 驗證結果：`);
        console.log(`   - 轉錄文字: ${transcriptText.substring(0, 50)}...`);
        console.log(`   - 轉錄狀態: ${status}`);
        break;
      }
    }
    
  } catch (error) {
    console.error('❌ 測試失敗:', error);
  }
}

// =====================================================================================
// 系統管理與觸發器設定
// =====================================================================================

/**
 * (優化版) 初始化系統
 */
function initializeSystem() {
  console.log('🚀 初始化銷售 AI 分析系統...');
  
  const healthCheck = systemHealthCheck();
  if (!healthCheck.config) {
    console.error('❌ 系統設定不完整，請檢查 config.gs 檔案');
    return;
  }
  
  // 建立核心觸發器
  createTrigger('processAllPendingAnalysis', 15); // AI 分析 (每15分鐘)
  createTrigger('smartAudioQueueProcessor', 5);   // 音檔轉錄佇列 (每5分鐘)
  createTrigger('syncFormToDatabase', 10);        // 資料同步 (每10分鐘)
  createTrigger('cleanupStuckProcessing', 60);    // 卡住的任務清理 (每小時)
  
  console.log('✅ 系統初始化完成！');
}

/**
 * (優化版) 停用系統
 */
function disableSystem() {
  console.log('🛑 停用所有系統觸發器...');
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  triggers.forEach(trigger => {
    ScriptApp.deleteTrigger(trigger);
    deletedCount++;
  });
  console.log(`✅ 成功刪除了 ${deletedCount} 個觸發器`);
}

/**
 * (優化版) 通用觸發器建立函數
 */
function createTrigger(functionName, minutes) {
  // 先刪除同名的舊觸發器
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // 建立新的觸發器
  const triggerBuilder = ScriptApp.newTrigger(functionName).timeBased();

  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    triggerBuilder.everyHours(hours);
    console.log(`✅ 已建立觸發器: ${functionName} (每 ${hours} 小時)`);
  } else {
    triggerBuilder.everyMinutes(minutes);
    console.log(`✅ 已建立觸發器: ${functionName} (每 ${minutes} 分鐘)`);
  }
  
  triggerBuilder.create();
}

/**
 * @deprecated - onEdit 觸發器因權限和可靠性問題已被停用
 */
function onAudioFormSpreadsheetEdit(e) {
  // 這個觸發器已被停用，邏輯改由定時執行的 syncFormToDatabase 處理，以確保可靠性。
  console.log('onEdit 觸發器已停用。');
}


// =====================================================================================
// 輔助與偵錯函數 (完整版)
// =====================================================================================

/**
 * 設定驗證函數
 */
function validateConfiguration() {
  const requiredConfigs = [
    { key: 'SPREADSHEET_ID', value: CONFIG.SPREADSHEET_ID },
    { key: 'GEMINI_API_KEY', value: CONFIG.GEMINI_API_KEY },
    { key: 'SLACK_BOT_TOKEN', value: CONFIG.SLACK_BOT_TOKEN }
  ];
  
  for (const config of requiredConfigs) {
    if (!config.value || config.value.includes('YOUR_')) {
      console.error(`❌ 設定錯誤: ${config.key} 未正確設定`);
      return false;
    }
  }
  return true;
}

/**
 * 系統健康檢查
 */
function systemHealthCheck() {
  console.log('🏥 執行系統健康檢查...');
  
  const results = {
    config: validateConfiguration(),
    sheets: false,
    gemini: false,
    slack: false
  };
  
  try {
    const sheet = getWorksheet();
    if (sheet) { results.sheets = true; }
  } catch (e) { console.error('❌ Google Sheets 連線失敗:', e); }
  
  try {
    results.gemini = testGeminiConnection();
  } catch (e) { console.error('❌ Gemini API 測試失敗:', e); }
  
  try {
    results.slack = testSlackConnection();
  } catch (e) { console.error('❌ Slack API 測試失敗:', e); }
  
  console.log('\n📋 健康檢查結果:');
  console.log(`設定檔: ${results.config ? '✅' : '❌'}`);
  console.log(`Google Sheets: ${results.sheets ? '✅' : '❌'}`);
  console.log(`Gemini API: ${results.gemini ? '✅' : '❌'}`);
  console.log(`Slack API: ${results.slack ? '✅' : '❌'}`);
  
  return results;
}

/**
 * 清理舊的處理中狀態 (避免卡住)
 */
function cleanupStuckProcessing() {
  console.log('🧹 清理卡住的處理狀態...');
  const sheet = getWorksheet();
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
  let cleanedCount = 0;
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const dataStatus = row[getColumnIndex(CONFIG.COLUMNS.DATA_STATUS)];
    const submissionTime = row[getColumnIndex(CONFIG.COLUMNS.SUBMISSION_TIME)];
    
    if (dataStatus === 'AI Analysis In Progress' || dataStatus === 'In Progress') {
       if (new Date(submissionTime) < sixtyMinutesAgo) {
        const caseId = row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)];
        markAsError(i + 1, caseId, '處理時間超過60分鐘，自動標記為錯誤');
        cleanedCount++;
      }
    }
  }
  console.log(`✨ 清理完成：共處理 ${cleanedCount} 筆卡住的記錄`);
}

/**
 * 處理 Google Forms 回饋表單回應
 */
function processFeedbackFormResponses() { /* ... (此函數內容未變，為求簡潔省略) ... */ }

/**
 * 更新銷售回饋資料到 Google Sheets
 */
function updateSalesFeedback(feedbackData) { /* ... (此函數內容未變，為求簡潔省略) ... */ }

/**
 * 檢查是否已經處理過特定的回饋
 */
function isFeedbackAlreadyProcessed(caseId, submissionTimestamp) { /* ... (此函數內容未變，為求簡潔省略) ... */ }

/**
 * 檢查系統是否被暫停
 */
function isSystemPaused() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const pausedUntil = properties.getProperty('SYSTEM_PAUSED_UNTIL');
    if (!pausedUntil) return false;
    if (new Date() >= new Date(pausedUntil)) {
      properties.deleteProperty('SYSTEM_PAUSED_UNTIL');
      return false;
    }
    return true;
  } catch (e) {
    console.error('❌ 檢查系統暫停狀態失敗:', e);
    return false;
  }
}

/**
 * 手動恢復系統
 */
function resumeSystemManually() { /* ... (此函數內容未變，為求簡潔省略) ... */ }

/**
 * 獲取系統狀態
 */
function getSystemStatus() { /* ... (此函數內容未變，為求簡潔省略) ... */ }

/**
 * 分析佇列狀態
 */
function analyzeQueueStatus(values) {
  let pending = 0, inProgress = 0, completed = 0, failed = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)] && row[getColumnIndex(CONFIG.COLUMNS.AUDIO_FILE_LINK)]) {
      const status = row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
      if (status === 'Pending' || !status) pending++;
      else if (status === 'In Progress') inProgress++;
      else if (status === 'Completed') completed++;
      else if (status === 'Failed') failed++;
    }
  }
  return { pending, inProgress, completed, failed, total: pending + inProgress + completed + failed };
}

/**
 * 找到下一個待處理任務（FIFO - 先進先出）
 */
function findNextPendingTask(values) {
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const status = row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
    if (row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)] && (status === 'Pending' || !status)) {
      return {
        rowIndex: i + 1,
        caseId: row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)],
        audioFileLink: row[getColumnIndex(CONFIG.COLUMNS.AUDIO_FILE_LINK)],
      };
    }
  }
  return null;
}

/**
 * 更新轉錄狀態
 */
function markTranscriptionStatus(caseId, status) {
  try {
    const sheet = getWorksheet();
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][getColumnIndex(CONFIG.COLUMNS.CASE_ID)] === caseId) {
        const rowIndex = i + 1;
        sheet.getRange(`${CONFIG.COLUMNS.TRANSCRIPTION_STATUS}${rowIndex}`).setValue(status);
        sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue(`${status} at ${new Date().toLocaleString()}`);
        console.log(`✅ 更新狀態: ${caseId} -> ${status}`);
        break;
      }
    }
  } catch (e) {
    console.error(`❌ 更新狀態失敗:`, e);
  }
}


/**
 * 補發遺漏的 Slack 通知
 * 這個函數會掃描 Master_Log，找出有分析結果但沒有通知時間戳記的項目，並嘗試重新發送通知。
 * 在執行此函數前，請務必先確認 User_Mapping 分頁的資料是正確的。
 */
function resendMissingNotifications() {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    let resendCount = 0;

    console.log('🚀 開始掃描需要補發的 Slack 通知...');

    // 使用 getColumnIndex 輔助函數，更安全地獲取欄位索引
    const caseIdCol = getColumnIndex(CONFIG.COLUMNS.CASE_ID);
    const emailCol = getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL);
    const analysisCol = getColumnIndex(CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT);
    const notificationCol = getColumnIndex(CONFIG.COLUMNS.NOTIFICATION_SENT); // J欄: 通知發送時間
    const feedbackUrlCol = getColumnIndex(CONFIG.COLUMNS.FEEDBACK_FORM_URL); // K欄: 回饋表單
    const storeNameCol = getColumnIndex(CONFIG.COLUMNS.STORE_NAME); // T欄: 店家名稱

    // 從第二行開始遍歷 (跳過標題)
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const analysisOutput = row[analysisCol];
      const notificationTimestamp = row[notificationCol]; // J欄的值

      // 條件：有分析結果且有效
      if (analysisOutput && analysisOutput.trim() !== '') {
        const caseId = row[caseIdCol];
        const salespersonEmail = row[emailCol];
        const feedbackFormUrl = row[feedbackUrlCol] || `${CONFIG.FEEDBACK_FORM_TEMPLATE}${encodeURIComponent(caseId)}`;
        const storeName = row[storeNameCol]; // 取得店家名稱

        // 檢查通知時間戳記，只有沒有值時才進行補發
        if (notificationTimestamp) {
          console.log(`⏭️ 案例 ${caseId} 已有通知記錄 (${notificationTimestamp})，跳過補發。`);
          continue; // 已有通知記錄，跳過
        }

        const displayName = storeName || '未知客戶';
        console.log(`🔄 找到案例 ${caseId} (${displayName}) (第 ${i + 1} 行)，準備補發通知給 ${salespersonEmail}...`);

        // 呼叫 Slack 通知函數，店家名稱可為空
        const success = sendSlackNotification(caseId, storeName, analysisOutput, salespersonEmail, feedbackFormUrl);

        if (success) {
          // 成功後，在對應的儲存格中填入當前時間
          sheet.getRange(i + 1, notificationCol + 1).setValue(new Date());
          console.log(`✅ 案例 ${caseId} 通知補發成功！`);
          resendCount++;
        } else {
          console.warn(`⚠️ 案例 ${caseId} 通知補發失敗。請檢查 '${salespersonEmail}' 是否在 User_Mapping 中有正確的 Slack ID。`);
        }

        // 避免請求過於頻繁，稍微等待
        Utilities.sleep(1200);
      }
    }

    console.log(`✨ 補發流程完成！共成功補發了 ${resendCount} 則通知。`);

  } catch (error) {
    console.error('❌ 執行補發通知時發生嚴重錯誤:', error);
    sendErrorNotification(`執行補發通知時發生嚴重錯誤: ${error.message}`);
  }
}
