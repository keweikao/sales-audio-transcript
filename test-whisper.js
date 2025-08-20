#!/usr/bin/env node

/**
 * 測試 whisper-node 功能
 */

const { whisper } = require('whisper-node');
const path = require('path');
const fs = require('fs');

async function testWhisper() {
  console.log('🧪 測試 whisper-node...');
  
  try {
    // 檢查 whisper 函數
    console.log('whisper 類型:', typeof whisper);
    
    if (typeof whisper !== 'function') {
      console.error('❌ whisper 不是函數');
      return;
    }
    
    console.log('✅ whisper 函數可用');
    
    // 檢查模型目錄
    const modelPath = path.join(__dirname, 'models', 'ggml-base.bin');
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      console.log(`✅ 模型檔案存在: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
    } else {
      console.log('⚠️ 模型檔案不存在，需要下載');
    }
    
    console.log('🎉 whisper-node 測試完成');
    
  } catch (error) {
    console.error('❌ 測試失敗:', error.message);
  }
}

// 如果直接執行此檔案
if (require.main === module) {
  testWhisper();
}

module.exports = { testWhisper };