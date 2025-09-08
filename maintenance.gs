/**
 * Google Apps Script - 維護與批次處理腳本
 */

/**
 * 當試算表開啟時，自動建立自訂選單。
 */
function onOpen() {
  SpreadsheetApp.getUi()
      .createMenu('⚙️ 維護工具')
      .addItem('指定案例重新分析...', 'reprocessAnalysisByCaseIds')
      .addItem('全自動重新分析遺漏項目', 'reprocessMissingAnalyses')
      .addSeparator()
      .addItem('補發所有遺漏的通知', 'resendMissingNotifications') // 這個函數在 main.gs
      .addSeparator()
      .addItem('啟用「定期補發通知」觸發器', 'setupMaintenanceTrigger')
      .addToUi();
}

/**
 * (已修正) 根據使用者在彈出視窗中輸入的 ID 列表，強制重新執行分析和通知流程。
 */
function reprocessAnalysisByCaseIds() {
  const ui = SpreadsheetApp.getUi();
  
  const response = ui.prompt(
    '指定案例重新分析',
    '請輸入要重新分析的 Case ID，如果有多個，請用逗號 (,) 分隔：',
    ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK || response.getResponseText().trim() === '') {
    ui.alert('操作已取消或未輸入任何 ID。');
    return;
  }

  const inputText = response.getResponseText();
  const targetCaseIds = inputText.split(',').map(id => id.trim()).filter(id => id);

  if (targetCaseIds.length === 0) {
    ui.alert('未找到有效的 Case ID。請確認輸入格式。');
    return;
  }

  console.log(`[START] 開始對 ${targetCaseIds.length} 個指定案例進行強制重新分析...`);
  console.log(`[INFO] 目標案例: ${targetCaseIds.join(', ')}`);

  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    const caseIdCol = getColumnIndex(CONFIG.COLUMNS.CASE_ID);
    let processedCount = 0;

    for (let i = 1; i < values.length; i++) {
      const currentRow = values[i];
      const currentCaseId = currentRow[caseIdCol];

      if (targetCaseIds.includes(currentCaseId)) {
        const rowIndex = i + 1;
        processedCount++;
        console.log(`\n[INFO] 找到目標案例 ${currentCaseId} (第 ${rowIndex} 行)，開始處理...`);

        try {
          console.log('[INFO] 清理舊的分析結果和狀態...');
          sheet.getRange(`${CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT}${rowIndex}`).clearContent();
          sheet.getRange(`${CONFIG.COLUMNS.NOTIFICATION_SENT}${rowIndex}`).clearContent();
          sheet.getRange(`${CONFIG.COLUMNS.FEEDBACK_FORM_URL}${rowIndex}`).clearContent();
          sheet.getRange(`${CONFIG.COLUMNS.RETRY_COUNT}${rowIndex}`).setValue(0);
          
          markAsProcessing(rowIndex, currentCaseId);
          
          const transcriptText = currentRow[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPT_TEXT)];
          const salespersonEmail = currentRow[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL)];

          if (!transcriptText || transcriptText.trim().length < 50) {
            throw new Error('轉錄文字太短或為空，無法進行分析');
          }

          console.log('[INFO] 重新呼叫 Gemini AI 分析...');
          const analysisOutput = analyzeTranscriptWithGemini(transcriptText);
          if (!analysisOutput || analysisOutput.trim() === '') {
            throw new Error('AI 分析結果為空');
          }

          console.log('[INFO] 準備重新發送 Slack 通知...');
          const feedbackFormUrl = `${CONFIG.FEEDBACK_FORM_TEMPLATE}${encodeURIComponent(currentCaseId)}`;
          const notificationSent = sendSlackNotification(currentCaseId, analysisOutput, salespersonEmail, feedbackFormUrl);
          const notificationTimestamp = notificationSent ? new Date() : '';

          console.log('[INFO] 正在將新的分析結果寫回工作表...');
          sheet.getRange(`${CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT}${rowIndex}`).setValue(analysisOutput);
          sheet.getRange(`${CONFIG.COLUMNS.AI_PROMPT_VERSION}${rowIndex}`).setValue(CONFIG.PROMPT_VERSION);
          sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue('AI Analysis Completed (Reprocessed)');
          sheet.getRange(`${CONFIG.COLUMNS.NOTIFICATION_SENT}${rowIndex}`).setValue(notificationTimestamp);
          sheet.getRange(`${CONFIG.COLUMNS.FEEDBACK_FORM_URL}${rowIndex}`).setValue(feedbackFormUrl);

          console.log(`[SUCCESS] 案例 ${currentCaseId} 重新分析成功！`);

        } catch (error) {
          console.error(`[ERROR] 處理案例 ${currentCaseId} 時發生錯誤:`, error);
          markAsError(rowIndex, currentCaseId, `Reprocess failed: ${error.message}`);
        }
        
        Utilities.sleep(1500);
      }
    }
    
    if (processedCount === 0) {
      ui.alert('找不到任何您指定的案例 ID。請檢查 ID 是否正確。');
    } else {
      ui.alert(`操作完成`, `成功為 ${processedCount} 個案例重新執行分析。`, ui.ButtonSet.OK);
    }

    console.log('\n[SUCCESS] 指定案例重新分析流程完成！');

  } catch (error) {
    console.error('[FATAL] 執行重新分析時發生嚴重錯誤:', error);
    sendErrorNotification(`執行重新分析時發生嚴重錯誤: ${error.message}`);
    ui.alert('執行失敗', `發生嚴重錯誤，請查看日誌了解詳情.\n錯誤訊息: ${error.message}`, ui.ButtonSet.OK);
  }
}

/**
 * (已修正) 批次重新處理所有遺漏的分析
 * 掃描 Master_Log，找出所有「G欄有內容」但「I欄為空」的項目，並為它們重新執行分析與通知。
 */
function reprocessMissingAnalyses() {
  console.log('[START] 開始批次重新處理所有遺漏的分析...');

  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    const transcriptCol = getColumnIndex(CONFIG.COLUMNS.TRANSCRIPT_TEXT);
    const analysisCol = getColumnIndex(CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT);
    const caseIdCol = getColumnIndex(CONFIG.COLUMNS.CASE_ID);
    const storeNameCol = getColumnIndex(CONFIG.COLUMNS.STORE_NAME); // 讀取客戶名稱欄位
    
    let processedCount = 0;

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const transcriptText = row[transcriptCol];
      const analysisOutput = row[analysisCol];
      const rowIndex = i + 1;

      if (transcriptText && transcriptText.trim() !== '' && (!analysisOutput || analysisOutput.trim() === '')) {
        processedCount++;
        const currentCaseId = row[caseIdCol];
        const storeName = row[storeNameCol]; // 取得客戶名稱
        console.log(`\n[INFO] 找到需要重新分析的案例 ${currentCaseId} (${storeName}) (第 ${rowIndex} 行)，開始處理...`);

        try {
          console.log('[INFO] 清理舊的狀態...');
          sheet.getRange(`${CONFIG.COLUMNS.NOTIFICATION_SENT}${rowIndex}`).clearContent();
          sheet.getRange(`${CONFIG.COLUMNS.FEEDBACK_FORM_URL}${rowIndex}`).clearContent();
          sheet.getRange(`${CONFIG.COLUMNS.RETRY_COUNT}${rowIndex}`).setValue(0);
          
          markAsProcessing(rowIndex, currentCaseId);
          
          const salespersonEmail = row[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL)];

          console.log('[INFO] 呼叫 Gemini AI 分析...');
          const newAnalysisOutput = analyzeTranscriptWithGemini(transcriptText);
          if (!newAnalysisOutput || newAnalysisOutput.trim() === '') {
            throw new Error('AI 分析結果為空');
          }

          console.log('[INFO] 準備發送 Slack 通知...');
          const feedbackFormUrl = `${CONFIG.FEEDBACK_FORM_TEMPLATE}${encodeURIComponent(currentCaseId)}`;
          const notificationSent = sendSlackNotification(currentCaseId, storeName, newAnalysisOutput, salespersonEmail, feedbackFormUrl);
          const notificationTimestamp = notificationSent ? new Date() : '';

          console.log('[INFO] 正在將新的分析結果寫回工作表...');
          sheet.getRange(`${CONFIG.COLUMNS.AI_ANALYSIS_OUTPUT}${rowIndex}`).setValue(newAnalysisOutput);
          sheet.getRange(`${CONFIG.COLUMNS.AI_PROMPT_VERSION}${rowIndex}`).setValue(CONFIG.PROMPT_VERSION);
          sheet.getRange(`${CONFIG.COLUMNS.DATA_STATUS}${rowIndex}`).setValue('AI Analysis Completed (Bulk Reprocessed)');
          sheet.getRange(`${CONFIG.COLUMNS.NOTIFICATION_SENT}${rowIndex}`).setValue(notificationTimestamp);
          sheet.getRange(`${CONFIG.COLUMNS.FEEDBACK_FORM_URL}${rowIndex}`).setValue(feedbackFormUrl);

          console.log(`[SUCCESS] 案例 ${currentCaseId} 重新分析成功！`);

        } catch (error) {
          console.error(`[ERROR] 處理案例 ${currentCaseId} 時發生錯誤:`, error);
          markAsError(rowIndex, currentCaseId, `Bulk Reprocess failed: ${error.message}`);
        }
        
        Utilities.sleep(1500);
      }
    }
    
    if (processedCount === 0) {
      console.log('[INFO] 找不到任何需要重新處理的案例。');
    }

    console.log(`\n[SUCCESS] 批次重新分析流程完成！共處理了 ${processedCount} 個案例。`);

  } catch (error) {
    console.error('[FATAL] 執行批次重新分析時發生嚴重錯誤:', error);
    sendErrorNotification(`執行批次重新分析時發生嚴重錯誤: ${error.message}`);
  }
}

/**
 * 排程的維護任務
 * 這個函數會被定時觸發器呼叫，用來執行安全的、定期的維護工作。
 */
function runScheduledMaintenance() {
  console.log("[START] 執行排程的維護任務...");
  
  try {
    console.log("[INFO] 正在補發遺漏的 Slack 通知...");
    // 注意：resendMissingNotifications 函數在 main.gs 中，但 Apps Script 共享全域命名空間，所以可以直接呼叫
    resendMissingNotifications();
  } catch (e) {
    console.error("[ERROR] 補發 Slack 通知時發生錯誤:", e);
    sendErrorNotification("執行 runScheduledMaintenance 中的 resendMissingNotifications 失敗: " + e.message);
  }

  console.log("[SUCCESS] 排程的維護任務執行完畢。");
}

/**
 * 設定維護任務的定時觸發器
 * 執行一次此函數，即可建立定時觸發器。
 */
function setupMaintenanceTrigger() {
  // 先檢查是否已有同名觸發器，避免重複建立
  const triggers = ScriptApp.getProjectTriggers();
  let triggerExists = false;
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'runScheduledMaintenance') {
      triggerExists = true;
    }
  });

  if (triggerExists) {
    console.log("⚠️ [INFO] 'runScheduledMaintenance' 的觸發器已經存在，無需重複建立。");
    return;
  }

  // 每 6 小時執行一次
  createTrigger('runScheduledMaintenance', 6 * 60); 
  console.log("✅ [SUCCESS] 已成功建立 'runScheduledMaintenance' 的定時觸發器，每 6 小時執行一次。");
}