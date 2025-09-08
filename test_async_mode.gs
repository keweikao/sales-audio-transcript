/**
 * 🧪 測試異步轉錄模式
 */
function testAsyncTranscriptionMode() {
  console.log('🧪 開始測試異步轉錄模式...');
  
  // 先檢查當前佇列狀態
  const currentStats = checkCurrentQueueStatus();
  
  if (currentStats.pending > 0) {
    console.log(`📋 發現 ${currentStats.pending} 個待處理任務，測試一次智能佇列處理`);
    
    // 執行一次佇列處理
    smartAudioQueueProcessor().then(() => {
      console.log('✅ 異步模式測試完成');
      console.log('📝 請檢查：');
      console.log('1. GAS 日誌是否顯示「轉錄請求已成功送出」');
      console.log('2. 任務狀態是否為 In Progress');
      console.log('3. Zeabur 是否在背景處理並最終更新狀態為 Completed');
    }).catch(error => {
      console.error('❌ 異步模式測試失敗:', error);
    });
  } else {
    console.log('⏭️ 沒有待處理任務可供測試');
    console.log('💡 請先添加一些音檔到 Google Form 表單');
  }
}

/**
 * 🔧 手動送出單一轉錄測試
 */
function testSingleTranscriptionRequest() {
  console.log('🔧 手動測試單一轉錄請求...');
  
  // 找一個 Pending 的任務來測試
  const sheet = getWorksheet();
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const caseId = row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)];
    const transcriptionStatus = row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
    const audioFileLink = row[getColumnIndex(CONFIG.COLUMNS.AUDIO_FILE_LINK)];
    const email = row[getColumnIndex(CONFIG.COLUMNS.SALESPERSON_EMAIL)];
    const timestamp = row[getColumnIndex(CONFIG.COLUMNS.SUBMISSION_TIME)];
    
    if (transcriptionStatus === 'Pending' && caseId && audioFileLink) {
      console.log(`🎯 找到測試任務: ${caseId}`);
      
      const testTask = {
        caseId: caseId,
        audioFileLink: audioFileLink,
        email: email,
        timestamp: timestamp
      };
      
      processNextTask(testTask).then(() => {
        console.log(`✅ 測試任務送出完成: ${caseId}`);
        console.log('⏳ 請等待 Zeabur 完成處理並更新狀態');
      }).catch(error => {
        console.error(`❌ 測試任務失敗: ${error.message}`);
      });
      
      return; // 只測試一個
    }
  }
  
  console.log('❌ 找不到 Pending 狀態的任務來測試');
}

/**
 * 📊 監控異步處理進度
 */
function monitorAsyncProcessing() {
  console.log('📊 開始監控異步處理進度...');
  
  const stats = checkCurrentQueueStatus();
  
  console.log('📈 當前處理狀況:');
  console.log(`- 等待處理: ${stats.pending} 個`);
  console.log(`- 正在處理: ${stats.inProgress} 個`);
  console.log(`- 已完成: ${stats.completed} 個`);
  console.log(`- 失敗: ${stats.failed} 個`);
  
  if (stats.inProgress > 0) {
    console.log('⏳ 有任務正在 Zeabur 背景處理中...');
    console.log('💡 建議每 5-10 分鐘執行此函數查看進度');
  } else if (stats.pending > 0) {
    console.log('🚀 有待處理任務，可執行智能佇列處理器');
  } else {
    console.log('✨ 目前沒有待處理的任務');
  }
}