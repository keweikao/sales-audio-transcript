/**
 * 🔄 停止所有轉錄作業並重新啟動智能佇列系統
 * 使用這個函數來停止當前的並行轉錄，實現真正的一進一出控制
 */
function restartQueueSystem() {
  console.log('🛑 開始重新啟動佇列系統...');
  
  // 步驟 1: 停止所有觸發器
  console.log('🔄 步驟 1: 停止所有觸發器...');
  disableSystem();
  
  // 步驟 2: 清除處理鎖
  console.log('🔄 步驟 2: 清除處理鎖...');
  PropertiesService.getScriptProperties().deleteProperty('QUEUE_PROCESSING_LOCK');
  
  // 步驟 3: 將所有 "In Progress" 任務重置為 "Pending"
  console.log('🔄 步驟 3: 重置所有進行中的任務...');
  resetInProgressTasks();
  
  // 步驟 4: 重新啟動智能佇列觸發器
  console.log('🔄 步驟 4: 重新啟動智能佇列觸發器...');
  setupSmartAudioQueue();
  
  console.log('✅ 佇列系統重新啟動完成！');
  console.log('📋 系統將以一進一出模式處理音檔轉錄（異步模式）');
  console.log('⏳ GAS 會送出轉錄請求，Zeabur 背景處理並自動更新狀態');
  
  // 步驟 5: 立即執行一次佇列處理
  console.log('🚀 立即執行一次佇列檢查...');
  setTimeout(() => {
    smartAudioQueueProcessor();
  }, 2000); // 延遲2秒執行
}

/**
 * 🔄 重置所有 "In Progress" 任務為 "Pending"
 */
function resetInProgressTasks() {
  try {
    const sheet = getWorksheet();
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    let resetCount = 0;
    
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const caseId = row[getColumnIndex(CONFIG.COLUMNS.CASE_ID)];
      const transcriptionStatus = row[getColumnIndex(CONFIG.COLUMNS.TRANSCRIPTION_STATUS)];
      
      if (transcriptionStatus === 'In Progress') {
        const rowIndex = i + 1;
        sheet.getRange(`${CONFIG.COLUMNS.TRANSCRIPTION_STATUS}${rowIndex}`).setValue('Pending');
        console.log(`🔄 重置任務狀態: ${caseId} -> Pending`);
        resetCount++;
      }
    }
    
    console.log(`✅ 已重置 ${resetCount} 個任務狀態為 Pending`);
    
  } catch (error) {
    console.error('❌ 重置任務狀態失敗:', error);
    throw error;
  }
}

/**
 * 🔍 檢查當前佇列狀態
 */
function checkCurrentQueueStatus() {
  try {
    const sheet = getWorksheet();
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    const stats = analyzeQueueStatus(values);
    
    console.log('📊 當前佇列狀態:');
    console.log(`- Pending: ${stats.pending}`);
    console.log(`- In Progress: ${stats.inProgress}`);
    console.log(`- Completed: ${stats.completed}`);
    console.log(`- Failed: ${stats.failed}`);
    console.log(`- Total: ${stats.total}`);
    
    // 檢查處理鎖
    const processingLock = PropertiesService.getScriptProperties().getProperty('QUEUE_PROCESSING_LOCK');
    if (processingLock) {
      const lockTime = new Date(parseInt(processingLock));
      console.log(`🔒 處理鎖狀態: 已鎖定 (時間: ${lockTime.toLocaleString()})`);
    } else {
      console.log(`🔓 處理鎖狀態: 未鎖定`);
    }
    
    return stats;
  } catch (error) {
    console.error('❌ 檢查佇列狀態失敗:', error);
    throw error;
  }
}