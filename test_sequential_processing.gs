/**
 * 🧪 測試 Zeabur 序列處理功能
 */
function testSequentialProcessing() {
  console.log('🧪 開始測試 Zeabur 序列處理功能...');
  
  // 檢查當前佇列狀態
  const stats = checkCurrentQueueStatus();
  
  if (stats.pending === 0) {
    console.log('❌ 沒有待處理任務可供測試');
    console.log('💡 請先添加一個音檔到 Google Form 表單');
    return;
  }
  
  if (stats.inProgress > 0) {
    console.log('⚠️ 已有任務在處理中，請等待完成後再測試');
    console.log(`📊 當前狀態: ${stats.inProgress} 個任務處理中`);
    return;
  }
  
  console.log(`📋 找到 ${stats.pending} 個待處理任務，開始測試序列處理`);
  
  // 執行智能佇列處理器
  smartAudioQueueProcessor().then(() => {
    console.log('✅ 序列處理測試已啟動');
    console.log('📝 請檢查 Zeabur 日誌是否顯示：');
    console.log('1. 🔄 嚴格序列處理每個 chunk，一次只處理一個');
    console.log('2. 🚀 啟動 Python Whisper 進程');
    console.log('3. ⏸️ 片段處理完成，等待 2 秒後處理下一片段');
    console.log('4. 🗑️ 已清理片段的臨時檔案');
    console.log('5. 🎉 所有片段序列處理完成');
    console.log('');
    console.log('⏰ 預計處理時間：每 30 分鐘片段約需 5-15 分鐘');
    console.log('📱 請使用 monitorSequentialProgress() 監控進度');
  }).catch(error => {
    console.error('❌ 序列處理測試失敗:', error);
  });
}

/**
 * 📊 監控序列處理進度
 */
function monitorSequentialProgress() {
  console.log('📊 監控序列處理進度...');
  
  const stats = checkCurrentQueueStatus();
  const timestamp = new Date().toLocaleString();
  
  console.log(`⏰ 時間: ${timestamp}`);
  console.log('📈 處理狀況:');
  console.log(`- 等待處理: ${stats.pending} 個`);
  console.log(`- 正在處理: ${stats.inProgress} 個`);
  console.log(`- 已完成: ${stats.completed} 個`);
  console.log(`- 失敗: ${stats.failed} 個`);
  
  if (stats.inProgress > 0) {
    console.log('🔄 Zeabur 正在序列處理音檔片段...');
    console.log('💡 建議 10 分鐘後再次檢查進度');
    console.log('🔍 可檢查 Zeabur 日誌查看詳細進度');
  } else if (stats.pending > 0) {
    console.log('⏳ 有待處理任務，可能需要重新啟動佇列處理器');
  } else {
    console.log('✅ 所有任務處理完成！');
  }
  
  return stats;
}

/**
 * 🔍 檢查 Zeabur 序列處理日誌
 */
function checkZeaburSequentialLogs() {
  console.log('🔍 檢查 Zeabur 序列處理日誌指南：');
  console.log('');
  console.log('📋 預期應該看到的日誌順序：');
  console.log('1. 🎵 開始處理片段 1/N');
  console.log('2. 🔧 預處理片段 1...');
  console.log('3. 🤖 轉錄片段 1，等待 Whisper 處理完成...');
  console.log('4. 🚀 啟動 Python Whisper 進程');
  console.log('5. 🤖 正在載入 Whisper 模型: base');
  console.log('6. 🎵 開始轉錄: processed_chunk_0.mp3');
  console.log('7. 🗑️ 轉錄完成，清理模型資源');
  console.log('8. ✅ 片段 1 轉錄完成 - 耗時: XX秒');
  console.log('9. 🗑️ 已清理片段 1 的臨時檔案');
  console.log('10. ⏸️ 片段 1 處理完成，等待 2 秒後處理下一片段...');
  console.log('11. （重複步驟 1-10 for 片段 2, 3, ...）');
  console.log('12. 🎉 所有 N 個片段序列處理完成');
  console.log('');
  console.log('🚫 不應該看到的並行處理日誌：');
  console.log('- 多個「開始處理片段」同時出現');
  console.log('- 多個「啟動 Python Whisper 進程」重疊');
  console.log('- ⚠️ 偵測到已有 Whisper 進程運行警告');
  console.log('');
  console.log('🔗 檢查方式：');
  console.log('1. 登入 Zeabur Dashboard');
  console.log('2. 進入 sales-audio-transcript 專案');
  console.log('3. 查看 Logs 分頁');
  console.log('4. 確認日誌按時間序列顯示序列處理');
}

/**
 * 📱 一鍵監控面板
 */
function sequentialProcessingDashboard() {
  console.log('📱 === Zeabur 序列處理監控面板 ===');
  console.log('');
  
  // 檢查當前狀態
  const stats = monitorSequentialProgress();
  console.log('');
  
  // 提供操作建議
  if (stats.inProgress > 0) {
    console.log('🎯 建議動作：');
    console.log('- 等待 Zeabur 完成當前任務');
    console.log('- 10 分鐘後重新執行此函數檢查進度');
    console.log('- 檢查 Zeabur 日誌確認序列處理正常');
  } else if (stats.pending > 0) {
    console.log('🎯 建議動作：');
    console.log('- 執行 testSequentialProcessing() 開始處理');
    console.log('- 或執行 restartQueueSystem() 重啟佇列');
  } else if (stats.failed > 0) {
    console.log('🎯 建議動作：');
    console.log('- 檢查失敗原因');
    console.log('- 考慮重試失敗的任務');
  } else {
    console.log('🎯 狀態：所有任務已完成！');
  }
  
  console.log('');
  console.log('🛠️ 可用功能：');
  console.log('- testSequentialProcessing() - 開始測試序列處理');
  console.log('- monitorSequentialProgress() - 監控處理進度');
  console.log('- checkZeaburSequentialLogs() - 檢查日誌指南');
  console.log('- restartQueueSystem() - 重啟佇列系統');
}